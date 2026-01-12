// Splat Viewer and AR Handler Library

// Import Three.js and addons
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRPlanes } from 'three/addons/webxr/XRPlanes.js';
import StatsDefault from 'stats.js';
const Stats = StatsDefault.default || StatsDefault;

// Make Three.js available globally
window.THREE = THREE;
window.OrbitControls = OrbitControls;
window.TransformControls = TransformControls;
window.ARButton = ARButton;
window.XRPlanes = XRPlanes;

// Legacy variable for compatibility (will be removed in Phase 6)
let GaussianSplats3D;

async function loadSparkLibrary() {
    // Try local src/ folder first (via importmap: @sparkjsdev/spark -> ./src/spark/spark.module.js)
    try {
        const Spark = await import('@sparkjsdev/spark');
        console.log('Spark library loaded from local src/ folder');
        return Spark;
    } catch (error) {
        console.warn('Failed to load from local src/ folder, trying CDN fallback:', error.message);
        // Fallback to CDN if local fails (for development flexibility)
        try {
            // @ts-ignore - Dynamic import from CDN, TypeScript cannot resolve at compile time
            const Spark = await import('https://sparkjs.dev/releases/spark/0.1.10/spark.module.js');
            console.log('Spark library loaded from CDN fallback');
            return Spark;
        } catch (error2) {
            console.error('Failed to load from CDN fallback:', error2);
            throw new Error('Could not load Spark library. Please ensure src/spark/spark.module.js exists or check your network connection.');
        }
    }
}

/**
 * Simple Damper class for smooth interpolation (model-viewer approach)
 */
class Damper {
    constructor(decayMilliseconds = 50) {
        this.velocity = 0;
        this.setDecayTime(decayMilliseconds);
    }

    setDecayTime(decayMilliseconds) {
        this.naturalFrequency = 1 / Math.max(1, decayMilliseconds);
    }

    update(x, xGoal, timeStepMilliseconds, xNormalization) {
        const nilSpeed = 0.0002 * this.naturalFrequency;

        if (x == null || xNormalization === 0) {
            return xGoal;
        }
        if (x === xGoal && this.velocity === 0) {
            return xGoal;
        }
        if (timeStepMilliseconds < 0) {
            return x;
        }

        const deltaX = (x - xGoal);
        const intermediateVelocity = this.velocity + this.naturalFrequency * deltaX;
        const intermediateX = deltaX + timeStepMilliseconds * intermediateVelocity;
        const decay = Math.exp(-this.naturalFrequency * timeStepMilliseconds);
        const newVelocity = (intermediateVelocity - this.naturalFrequency * intermediateX) * decay;
        const acceleration = -this.naturalFrequency * (newVelocity + intermediateVelocity * decay);

        if (Math.abs(newVelocity) < nilSpeed * Math.abs(xNormalization) && acceleration * deltaX >= 0) {
            this.velocity = 0;
            return xGoal;
        } else {
            this.velocity = newVelocity;
            return xGoal + intermediateX * decay;
        }
    }
}

// Global registry to track all active SplatViewer instances
// Used to coordinate rendering when multiple viewers exist
const activeViewers = new Set();

// Get the currently active AR viewer (only one can be in AR at a time)
function getActiveARViewer() {
    for (const viewer of activeViewers) {
        if (viewer.xrSession && viewer.renderer && viewer.renderer.xr && viewer.renderer.xr.isPresenting) {
            return viewer;
        }
    }
    return null;
}

// Check if any viewer is currently in AR mode
function isAnyViewerInAR() {
    return getActiveARViewer() !== null;
}

// Check if a container is visible in the viewport
function isContainerVisible(container) {
    if (!container) return false;
    
    const rect = container.getBoundingClientRect();
    const style = window.getComputedStyle(container);
    
    // Check if element is hidden via CSS
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    
    // Check if element is in viewport (with some margin for pre-rendering)
    const margin = 100; // pixels
    return (
        rect.top < window.innerHeight + margin &&
        rect.bottom > -margin &&
        rect.left < window.innerWidth + margin &&
        rect.right > -margin
    );
}

export class SplatViewer {
    constructor(container, options = {}) {
        this.container = container;
        this.viewer = null;
        this.library = null;
        this.options = {
            splatFile: options.splatFile || null,
            enableAR: options.enableAR !== false,
            useBuiltInControls: options.useBuiltInControls !== false,
            showFPS: options.showFPS === true || options.showFPS === 'true',
            minScale: options.minScale !== undefined ? options.minScale : 0.1,
            maxScale: options.maxScale !== undefined ? options.maxScale : 5.0,
            ...options
        };
        this.stats = null; // Stats.js instance for FPS monitoring
        this.xrButton = null;
        this.exitARButton = null;
        this.statusDiv = null;
        this.statusFadeTimeout = null; // Timeout for fading out status messages
        this.preARCameraState = null; // Store camera state before entering AR
        this.xrSession = null;
        this.hitTestSource = null;
        this.initialHitSource = null; // For automatic floor detection (model-viewer approach)
        this.transientHitTestSource = null; // For touch input (like model-viewer)
        this.localFloorReferenceSpace = null; // Deprecated - now using Three.js's reference space
        this.frame = null; // Current XR frame for processInput
        this.firstRatio = 0; // For two-finger scale (deprecated)
        this.lastAngle = undefined; // For two-finger rotate - undefined to skip first delta
        this.initialSeparation = 0; // For scale gesture - initial finger separation
        this.initialScale = 1; // For scale gesture - initial mesh scale
        this.splatPlaced = false;
        this.orbitControls = null; // Manual OrbitControls for desktop mode
        this.reticle = null; // AR reticle for placement
        this.manipulationRing = null; // Manipulation feedback ring (model-viewer style)
        this.manipulationRingFadeStartTime = 0; // Track fade animation start time
        this.manipulationRingHideTimeout = null; // Delayed hide timeout
        this.debugFloorPlane = null; // Debug wireframe plane showing estimated floor
        this.showDebugFloor = false; // Set to true to show debug floor plane in AR
        this.pendingHitPosition = null; // Pending hit position for tap placement
        this.pendingHitQuaternion = null; // Pending hit quaternion for tap placement
        this.arFrameLoopActive = false; // Track if AR frame loop is active
        this._isExitingAR = false; // Prevent double-calling exitAR
        this.arTapHandler = null; // Tap event handler for cleanup
        this.desktopAnimationLoop = null; // Store the original desktop animation loop
        this.arTransformControls = null; // Transform controls for AR mode (move, rotate, scale)
        this.arTransformMode = 'translate'; // Current transform mode: 'translate', 'rotate', 'scale'
        this.xrInputSources = []; // Track active XR input sources
        this.xrInputStartPositions = []; // Track start positions for XR input gestures
        this._lastActiveCount = 0; // Track active input count for debug logging
        this._lastInputSourcesCount = 0; // Track inputSources count changes
        this._isPaused = false; // Track if this viewer is paused (for multi-viewer optimization)
        this._visibilityObserver = null; // IntersectionObserver for visibility tracking
        
        // Model-viewer approach: goalPosition with smooth interpolation
        this.goalPosition = new window.THREE.Vector3(0, 0, 0);
        this.xDamper = new Damper(50);
        this.yDamper = new Damper(50);
        this.zDamper = new Damper(50);
        this.placementBox = null; // PlacementBox for visual feedback
        this.placementComplete = false; // Track if placement animation is complete
        
        // Floor tracking debug
        this.lastHitFloorY = null; // Last detected floor Y from hit-test
        this.floorTrackingLogInterval = 0; // Counter for throttled logging
        this._splatFirstRenderComplete = false; // Flag to track when splat first renders
        this.arSupported = false; // Track AR support status
    }

    async init() {
        try {
            // Load the Spark library
            this.library = await loadSparkLibrary();
            // Store for compatibility (will be removed in Phase 6)
            GaussianSplats3D = this.library;

            // Create Three.js scene, camera, renderer manually
            this.scene = new window.THREE.Scene();
            
            // Create camera with proper aspect ratio
            const width = this.container.clientWidth || window.innerWidth;
            const height = this.container.clientHeight || window.innerHeight;
            this.camera = new window.THREE.PerspectiveCamera(
                75, 
                width / height, 
                0.1, 
                1000
            );
            
            // Set initial camera position for desktop mode (will orbit around origin)
            // Default: position camera at a reasonable distance from origin
            const transform = this.options.transform || {};
            const initialCameraPosition = transform.cameraPosition || { x: 0, y: 0, z: 10 };
            
            if (Array.isArray(initialCameraPosition)) {
                this.camera.position.set(
                    initialCameraPosition[0] || 0,
                    initialCameraPosition[1] || 0,
                    initialCameraPosition[2] || 10
                );
            } else {
                this.camera.position.set(
                    initialCameraPosition.x || 0,
                    initialCameraPosition.y || 0,
                    initialCameraPosition.z || 10
                );
            }
            
            // Set initial camera look-at from config, or default to origin (0, 0, 0)
            // This will be properly applied in applyCameraTransform(), but set it here for initial state
            let initialLookAtX = 0, initialLookAtY = 0, initialLookAtZ = 0;
            if (transform.cameraLookAt && Array.isArray(transform.cameraLookAt) && transform.cameraLookAt.length >= 3) {
                initialLookAtX = transform.cameraLookAt[0] || 0;
                initialLookAtY = transform.cameraLookAt[1] || 0;
                initialLookAtZ = transform.cameraLookAt[2] || 0;
            }
            this.camera.lookAt(initialLookAtX, initialLookAtY, initialLookAtZ);
            
            // Create renderer
            // Performance optimization: antialias should be false for splat rendering
            // (Spark.js docs: "Rendering splats doesn't benefit from multisampling")
            this.renderer = new window.THREE.WebGLRenderer({ 
                antialias: false,
                alpha: true // For AR transparency
            });
            this.renderer.setSize(width, height);
            // Performance optimization: Consider if high DPI rendering is needed
            // For scenes with mostly splats, may want to use 1 instead of devicePixelRatio
            // Using devicePixelRatio for now, but can be optimized per use case
            this.renderer.setPixelRatio(window.devicePixelRatio);
            
            // Enable WebXR if needed
            if (this.options.enableAR) {
                this.renderer.xr.enabled = true;
            }
            
            // Add canvas to container
            this.container.appendChild(this.renderer.domElement);
            
            // Handle window resize (but not during AR mode)
            window.addEventListener('resize', () => {
                // Don't resize during AR mode - WebXR handles this automatically
                if (this.renderer.xr && this.renderer.xr.isPresenting) {
                    return;
                }
                
                const newWidth = this.container.clientWidth || window.innerWidth;
                const newHeight = this.container.clientHeight || window.innerHeight;
                this.camera.aspect = newWidth / newHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(newWidth, newHeight);
            });
            
            // Create compatibility shim for this.viewer (will be removed in Phase 6)
            this.viewer = {
                camera: this.camera,
                renderer: this.renderer,
                threeScene: this.scene,
                splatMesh: null // Will be set when splat is loaded
            };
            
            // Apply camera transform after setup
            this.applyCameraTransform();

            // Initialize FPS stats if enabled
            if (this.options.showFPS) {
                this.initStats();
            }

            // Register this viewer in the global registry
            activeViewers.add(this);
            
            // Setup visibility observer to pause rendering when not visible
            this.setupVisibilityObserver();

            // Setup animation loop for desktop mode
            this.setupAnimationLoop();

            // Setup window resize handler
            this.resizeHandler = () => this.onWindowResize();
            window.addEventListener('resize', this.resizeHandler);

            // Hide any AR buttons created by the GaussianSplats3D library
            this.hideLibraryARButtons();

            // Setup WebXR button
            this.setupWebXRButton();

            // Load splat file if provided
            if (this.options.splatFile) {
                await this.loadSplat(this.options.splatFile);
            } else {
                this.updateStatus('Error: No splat file specified. Please provide a splat-src attribute.');
                console.error('SplatViewer: No splat file specified. Please provide a splat-src attribute.');
            }

            return this.viewer;
        } catch (error) {
            console.error('Initialization error:', error);
            this.updateStatus('Error initializing viewer: ' + error.message);
            throw error;
        }
    }

    applyCameraTransform() {
        if (!this.camera) return;
        
        // In desktop mode, orbit around origin (0, 0, 0) where the splat sits
        const isAR = this.renderer && this.renderer.xr && this.renderer.xr.isPresenting;
        
        if (!isAR) {
            // Desktop mode: orbit around origin
            const transform = this.options.transform || {};
            
            // Apply camera position from config, or default
            if (transform.cameraPosition) {
                this.camera.position.set(
                    transform.cameraPosition.x || 0,
                    transform.cameraPosition.y || 0,
                    transform.cameraPosition.z || 10
                );
            } else {
                this.camera.position.set(0, 0, 10);
            }
            
            // Apply camera look-at from config, or default to origin (0, 0, 0)
            let lookAtX = 0, lookAtY = 0, lookAtZ = 0;
            if (transform.cameraLookAt && Array.isArray(transform.cameraLookAt) && transform.cameraLookAt.length >= 3) {
                lookAtX = transform.cameraLookAt[0] || 0;
                lookAtY = transform.cameraLookAt[1] || 0;
                lookAtZ = transform.cameraLookAt[2] || 0;
            }
            
            this.camera.lookAt(lookAtX, lookAtY, lookAtZ);
            
            if (this.orbitControls) {
                this.orbitControls.target.set(lookAtX, lookAtY, lookAtZ);
                this.orbitControls.update();
            }
        } else {
            // AR mode: use transform if specified (for initial positioning)
            const transform = this.options.transform || {};
            if (transform.cameraPosition) {
                this.camera.position.set(
                    transform.cameraPosition.x || this.camera.position.x,
                    transform.cameraPosition.y || this.camera.position.y,
                    transform.cameraPosition.z || this.camera.position.z
                );
            }
        }
    }

    applyTransformToMesh(mesh, mode) {
        if (!mesh || !window.THREE) return;
        
        // Determine which transform to use based on mode
        let transform = this.options.transform || null;
        const isAR = this.viewer.renderer && this.viewer.renderer.xr && this.viewer.renderer.xr.isPresenting;
        const isVR = false; // Can be detected if needed
        
        if (mode === 'ar' || (isAR && this.options.transformAr)) {
            transform = this.options.transformAr || transform;
        } else if (mode === 'vr' || (isVR && this.options.transformVr)) {
            transform = this.options.transformVr || transform;
        } else {
            transform = this.options.transform || null;
        }
        
        if (!transform) {
            // If no transform, reset to origin for desktop mode
            if (mode === 'desktop') {
                mesh.position.set(0, 0, 0);
                mesh.rotation.set(0, 0, 0);
                mesh.scale.set(1, 1, 1);
                mesh.updateMatrix();
                mesh.updateMatrixWorld(true);
            }
            return;
        }
        
        // Apply position (reset to origin first if in desktop mode to ensure proper centering)
        if (mode === 'desktop') {
            mesh.position.set(0, 0, 0);
        }
        if (transform.position) {
            mesh.position.set(
                transform.position.x || 0,
                transform.position.y || 0,
                transform.position.z || 0
            );
        }
        
        // Apply scale
        if (transform.scale) {
            mesh.scale.set(
                transform.scale.x || 1,
                transform.scale.y || 1,
                transform.scale.z || 1
            );
        }
        
        // Apply rotation (in degrees, convert to radians)
        if (transform.rotate) {
            const rotationX = (transform.rotate.x || 0) * (Math.PI / 180);
            const rotationY = (transform.rotate.y || 0) * (Math.PI / 180);
            const rotationZ = (transform.rotate.z || 0) * (Math.PI / 180);
            
            // Apply the rotations directly (Y-up coordinate system)
            const euler = new window.THREE.Euler(rotationX, rotationY, rotationZ, 'XYZ');
            mesh.quaternion.setFromEuler(euler);
            mesh.rotation.setFromQuaternion(mesh.quaternion);
        }
        
        // Force matrix update
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
    }

    applyTransforms() {
        if (!this.viewer || !window.THREE) return;
        
        // Try multiple times with increasing delays to find the mesh
        const tryApplyTransform = (attempt = 0) => {
            const maxAttempts = 5; // Reduced attempts since we try earlier now
            const delay = 200 * (attempt + 1); // 200ms, 400ms, 600ms, etc.
            
            setTimeout(() => {
                // Try different methods to find the splat mesh
                let mesh = null;
                
                // Method 1: Direct property
                if (this.viewer.splatMesh) {
                    mesh = this.viewer.splatMesh;
                }
                // Method 2: Getter method
                else if (this.viewer.getSplatMesh) {
                    mesh = this.viewer.getSplatMesh();
                }
                // Method 3: Search in scene
                else if (this.viewer.threeScene) {
                    this.viewer.threeScene.traverse((child) => {
                        if (!mesh) {
                            // Check various ways the mesh might be identified
                            if (child.userData && child.userData.isSplatMesh) {
                                mesh = child;
                            } else if (child.type === 'Points' || child.type === 'Mesh') {
                                // Might be the splat mesh
                                if (child.geometry && child.geometry.attributes && child.geometry.attributes.position) {
                                    mesh = child;
                                }
                            }
                        }
                    });
                }
                
                if (!mesh && attempt < maxAttempts) {
                    // Try again
                    tryApplyTransform(attempt + 1);
                    return;
                }
                
                if (!mesh) {
                    return;
                }
                
                // Store mesh for future use
                this.viewer.splatMesh = mesh;
                
                // Determine mode
                const isAR = this.viewer.renderer && this.viewer.renderer.xr && this.viewer.renderer.xr.isPresenting;
                const mode = isAR ? 'ar' : 'desktop';
                
                // Apply transform using the helper method
                this.applyTransformToMesh(mesh, mode);
            }, delay);
        };
        
        // Start trying to apply transform (only if mesh wasn't found earlier)
        if (!this.viewer.splatMesh) {
            tryApplyTransform(0);
        }
    }

    setupVisibilityObserver() {
        // Use IntersectionObserver to detect when viewer is visible
        if (!('IntersectionObserver' in window)) {
            console.warn('IntersectionObserver not supported, visibility optimization disabled');
            return;
        }

        this._visibilityObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
                if (!isVisible && !this._isPaused) {
                    // Pause rendering when not visible
                    this.pauseRendering();
                } else if (isVisible && this._isPaused && !isAnyViewerInAR()) {
                    // Resume rendering when visible and no other viewer is in AR
                    this.resumeRendering();
                }
            }
        }, {
            threshold: [0, 0.1], // Trigger when 0% or 10% visible
            rootMargin: '50px' // Consider element visible if within 50px of viewport
        });

        // Observe the container
        if (this.container) {
            this._visibilityObserver.observe(this.container);
        }
    }

    pauseRendering() {
        if (this._isPaused) return;
        this._isPaused = true;
        
        // Pause the animation loop
        if (this.renderer) {
            this.renderer.setAnimationLoop(null);
        }
        
        console.log('Viewer paused (not visible or another viewer in AR)');
    }

    resumeRendering() {
        if (!this._isPaused) return;
        if (this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
            // Don't resume if we're in AR mode (AR has its own loop)
            return;
        }
        
        // Don't resume if another viewer is in AR
        const activeARViewer = getActiveARViewer();
        if (activeARViewer && activeARViewer !== this) {
            return;
        }
        
        this._isPaused = false;
        
        // Resume the animation loop
        if (this.desktopAnimationLoop && this.renderer) {
            this.renderer.setAnimationLoop(this.desktopAnimationLoop);
        }
        
        console.log('Viewer resumed');
    }

    setupAnimationLoop() {
        if (!this.renderer || !this.scene || !this.camera) return;

        // Create desktop animation loop
        const animate = (time, frame) => {
            // Don't do anything if in AR mode - AR frame loop handles it
            if (this.renderer.xr && this.renderer.xr.isPresenting) {
                return;
            }
            
            // Performance optimization: Skip rendering if paused or not visible
            if (this._isPaused) {
                return;
            }
            
            // Performance optimization: Skip rendering if another viewer is in AR
            const activeARViewer = getActiveARViewer();
            if (activeARViewer && activeARViewer !== this) {
                return;
            }
            
            // Performance optimization: Skip rendering if container is not visible
            if (!isContainerVisible(this.container)) {
                return;
            }
            
            // Begin stats measurement
            if (this.stats) {
                this.stats.begin();
            }
            
            // Update OrbitControls for desktop mode (not in AR)
            if (this.orbitControls && this.orbitControls.enabled) {
                this.orbitControls.update();
            }

            // Render scene (only in desktop mode)
            this.renderer.render(this.scene, this.camera);
            
            // Check if splat has been rendered for the first time
            if (!this._splatFirstRenderComplete && this.splatMesh && this.splatMesh.visible) {
                // Wait one more frame to ensure the render is complete
                requestAnimationFrame(() => {
                    this._splatFirstRenderComplete = true;
                    // Check if AR is supported and show appropriate message
                    if (this.arSupported) {
                        this.updateStatus('Gaussian splat loaded successfully!');
                    } else if (this.options.enableAR) {
                        // AR is enabled but not supported - show message indicating this
                        this.updateStatus('Gaussian splat loaded successfully! AR is not supported on this platform.');
                    } else {
                        // AR is disabled - just show success message
                        this.updateStatus('Gaussian splat loaded successfully!');
                    }
                });
            }
            
            // End stats measurement
            if (this.stats) {
                this.stats.end();
            }
        };

        // Set animation loop
        this.renderer.setAnimationLoop(animate);
        
        // Store for restoration when exiting AR
        this.desktopAnimationLoop = animate;
        
        console.log('Animation loop setup complete');
    }
    
    initStats() {
        try {
            if (!Stats) {
                console.warn('Stats.js not available');
                return;
            }
            
            console.log('Initializing Stats.js...', { Stats, container: this.container });
            this.stats = new Stats();
            this.stats.showPanel(0); // 0: FPS, 1: MS, 2: MB
            
            // Find the custom element (splat-viewer) that contains this container
            // Stats should be positioned relative to the splat-viewer container
            let customElement = this.container;
            // If container is #canvas-container, get its parent (the custom element)
            if (customElement.id === 'canvas-container') {
                customElement = customElement.parentElement;
            }
            // Fallback: traverse up to find splat-viewer element
            while (customElement && customElement.tagName !== 'SPLAT-VIEWER' && customElement.parentElement) {
                customElement = customElement.parentElement;
            }
            
            const root = customElement || this.container;
            
            if (this.stats.dom) {
                // Style the stats element for positioning within splat-viewer
                this.stats.dom.style.position = 'absolute';
                this.stats.dom.style.top = '16px';
                this.stats.dom.style.left = '16px';
                this.stats.dom.style.zIndex = '10001';
                this.stats.dom.style.visibility = 'visible';
                this.stats.dom.style.display = 'block';
                this.stats.dom.style.pointerEvents = 'auto';
                this.stats.dom.classList.add('splat-viewer-stats');
                
                // Append to the splat-viewer element (not document.body)
                root.appendChild(this.stats.dom);
                console.log('Stats.js initialized and added to splat-viewer container');
            } else {
                console.error('Cannot initialize stats - stats.dom missing');
            }
        } catch (error) {
            console.error('Error initializing Stats.js:', error);
        }
    }

    setupOrbitControls() {
        if (!this.renderer || !this.camera || !window.OrbitControls) return;
        
        // Only setup OrbitControls for non-AR mode
        // In AR mode, WebXR handles camera control
        if (this.renderer.xr && this.renderer.xr.isPresenting) {
            // Disable existing controls if in AR mode
            if (this.orbitControls) {
                this.orbitControls.enabled = false;
            }
            return;
        }

        // Remove existing controls if they exist
        if (this.orbitControls) {
            this.orbitControls.dispose();
        }

        // Create OrbitControls
        this.orbitControls = new window.OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.05;
        this.orbitControls.screenSpacePanning = true;
        this.orbitControls.minDistance = 0.1;
        this.orbitControls.maxDistance = 100;
        this.orbitControls.maxPolarAngle = Math.PI;
        this.orbitControls.enabled = true;

        // Position camera at a reasonable distance from origin if not already set
        // This allows proper orbiting around the splat
        const transform = this.options.transform || {};
        if (transform.cameraPosition) {
            // Use the specified camera position
            this.camera.position.set(
                transform.cameraPosition.x || 0,
                transform.cameraPosition.y || 0,
                transform.cameraPosition.z || 0
            );
        } else {
            // Default camera position: look at origin from a distance
            this.camera.position.set(0, 0, 10);
        }
        
        // Get camera look-at from config, or default to origin (0, 0, 0)
        let lookAtX = 0, lookAtY = 0, lookAtZ = 0;
        if (transform.cameraLookAt && Array.isArray(transform.cameraLookAt) && transform.cameraLookAt.length >= 3) {
            lookAtX = transform.cameraLookAt[0] || 0;
            lookAtY = transform.cameraLookAt[1] || 0;
            lookAtZ = transform.cameraLookAt[2] || 0;
        }
        
        // Set OrbitControls target to the look-at point so camera orbits around it
        this.orbitControls.target.set(lookAtX, lookAtY, lookAtZ);
        
        // Make camera look at the configured point
        this.camera.lookAt(lookAtX, lookAtY, lookAtZ);
        
        // Ensure OrbitControls target is set and update
        this.orbitControls.update();
        
        // Force camera to look at the configured point after OrbitControls update
        // This ensures the camera is properly aligned
        this.camera.lookAt(lookAtX, lookAtY, lookAtZ);
        
        // Setup gesture detection to hide controls hint
        this.setupControlsHintFade();
        
        console.log('OrbitControls setup complete - orbiting around origin (0, 0, 0)');
    }
    
    setupControlsHintFade() {
        if (!this.controlsHint || !this.renderer || !this.renderer.domElement) return;
        
        const canvas = this.renderer.domElement;
        let hintHidden = false;
        
        const hideHint = () => {
            if (!hintHidden && this.controlsHint) {
                hintHidden = true;
                this.controlsHint.classList.add('hidden');
            }
        };
        
        // Detect mouse drag (mousedown + mousemove)
        let isDragging = false;
        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
        }, { passive: true });
        
        canvas.addEventListener('mousemove', (e) => {
            if (isDragging) {
                hideHint();
            }
        }, { passive: true });
        
        canvas.addEventListener('mouseup', () => {
            isDragging = false;
        }, { passive: true });
        
        canvas.addEventListener('mouseleave', () => {
            isDragging = false;
        }, { passive: true });
        
        // Detect scroll/wheel (zoom)
        canvas.addEventListener('wheel', (e) => {
            hideHint();
        }, { passive: true });
        
        // Detect touch drag (touchstart + touchmove)
        let isTouchDragging = false;
        canvas.addEventListener('touchstart', (e) => {
            isTouchDragging = true;
        }, { passive: true });
        
        canvas.addEventListener('touchmove', (e) => {
            if (isTouchDragging) {
                hideHint();
            }
        }, { passive: true });
        
        canvas.addEventListener('touchend', () => {
            isTouchDragging = false;
        }, { passive: true });
        
        canvas.addEventListener('touchcancel', () => {
            isTouchDragging = false;
        }, { passive: true });
    }

    hideLibraryARButtons() {
        // The GaussianSplats3D library may create its own AR button
        // Find and hide any buttons created by the library
        // This function aggressively searches and removes library-created AR buttons
        
        const hideButton = (button) => {
            if (!button) return;
            
            const buttonId = button.getAttribute('id');
            // Skip our custom buttons and test buttons
            if (buttonId === 'enter-ar-btn' || buttonId === 'exit-ar-btn' || 
                buttonId === 'test-ar-btn' || buttonId?.startsWith('test-')) return;
            
            // Aggressively hide and remove the button
            button.style.display = 'none !important';
            button.style.visibility = 'hidden';
            button.style.opacity = '0';
            button.style.pointerEvents = 'none';
            button.classList.add('hidden');
            button.setAttribute('aria-hidden', 'true');
            
            // Try to remove from DOM
            try {
                if (button.parentNode) {
                    button.parentNode.removeChild(button);
                }
            } catch (e) {
                // If removal fails, at least it's hidden
            }
            
            console.log('Hidden library AR button:', button);
        };
        
        const searchAndHide = () => {
            // Search entire document, not just container
            const allButtons = document.querySelectorAll('button');
            allButtons.forEach(button => {
                const buttonId = button.getAttribute('id');
                if (buttonId === 'enter-ar-btn' || buttonId === 'exit-ar-btn') return;
                
                // Check if it looks like an AR button
                const buttonText = button.textContent?.toLowerCase() || '';
                const buttonClass = button.className?.toLowerCase() || '';
                const buttonStyle = button.getAttribute('style') || '';
                
                const hasARText = buttonText.includes('ar') || 
                                 buttonText.includes('augmented') || 
                                 buttonText.includes('xr') || 
                                 buttonText.includes('view in') ||
                                 buttonText.includes('immersive');
                
                const hasARClass = buttonClass.includes('ar') || 
                                  buttonClass.includes('xr') || 
                                  buttonClass.includes('webxr') ||
                                  button.classList.contains('ar-button') ||
                                  button.classList.contains('webxr-button');
                
                const hasARStyle = buttonStyle.includes('ar') || buttonStyle.includes('xr');
                
                // Also check for buttons without IDs (library buttons often don't have custom IDs)
                const noCustomId = !buttonId || buttonId === '';
                
                // If it matches any AR pattern, hide it
                if (hasARText || hasARClass || hasARStyle || 
                    button.getAttribute('data-ar-button') !== null ||
                    (noCustomId && buttonText.length > 0 && buttonText.length < 50)) {
                    hideButton(button);
                }
            });
            
            // Check viewer object properties
            if (this.viewer) {
                const possibleButtonProps = ['arButton', 'xrButton', 'webXRButton', 'button', 'uiButton', 'arButtonElement'];
                possibleButtonProps.forEach(prop => {
                    try {
                        if (this.viewer[prop] && this.viewer[prop] instanceof HTMLElement) {
                        const libButton = this.viewer[prop];
                        if (libButton.tagName === 'BUTTON' && 
                            libButton.id !== 'enter-ar-btn' && 
                            libButton.id !== 'exit-ar-btn') {
                            console.log('Found library AR button in viewer property:', prop);
                            hideButton(libButton);
                        }
                    }
                    } catch (e) {
                        // Property might not be accessible
                    }
                });
            }
        };
        
        // Initial search immediately
        searchAndHide();
        
        // Search after delays to catch buttons created asynchronously
        setTimeout(searchAndHide, 50);
        setTimeout(searchAndHide, 100);
        setTimeout(searchAndHide, 250);
        setTimeout(searchAndHide, 500);
        setTimeout(searchAndHide, 1000);
        
        // Use MutationObserver to catch buttons added dynamically
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) { // Element node
                            if (node.tagName === 'BUTTON') {
                                searchAndHide();
                            } else if (node.querySelectorAll) {
                                // Check if any buttons were added inside this node
                                const buttons = node.querySelectorAll('button');
                                if (buttons.length > 0) {
                                    searchAndHide();
                                }
                            }
                        }
                    });
                });
            });
            
            // Observe the entire document for button additions
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            // Store observer for cleanup if needed
            this.arButtonObserver = observer;
        }
    }

    setupWebXRButton() {
        // Get UI element references (model-viewer style)
        // Find the custom element (splat-viewer) that contains this container
        // Status div and other UI elements are siblings of canvas-container, not children
        let customElement = this.container;
        // If container is #canvas-container, get its parent (the custom element)
        if (customElement.id === 'canvas-container') {
            customElement = customElement.parentElement;
        }
        // Fallback: traverse up to find splat-viewer element
        while (customElement && customElement.tagName !== 'SPLAT-VIEWER' && customElement.parentElement) {
            customElement = customElement.parentElement;
        }
        
        // Use querySelector on the custom element to find elements within this specific viewer instance
        // This ensures each viewer instance finds its own UI elements when multiple viewers exist
        const root = customElement || this.container;
        this.statusDiv = root.querySelector('#status') || document.getElementById('status');
        this.arButton = root.querySelector('#enter-ar-btn') || document.getElementById('enter-ar-btn');
        this.exitARButton = root.querySelector('#exit-ar-btn') || document.getElementById('exit-ar-btn');
        this.arOverlay = root.querySelector('#ar-overlay') || document.getElementById('ar-overlay');
        this.arPrompt = root.querySelector('#ar-prompt') || document.getElementById('ar-prompt');
        this.arHandPrompt = root.querySelector('#ar-hand-prompt') || document.getElementById('ar-hand-prompt');
        this.controlsHint = root.querySelector('#controls-hint') || document.getElementById('controls-hint');
        
        // Apply theme to status and controls hint (only in desktop mode, not AR)
        if (this.statusDiv && this.controlsHint) {
            const theme = this.options.theme || 'dark';
            // Remove existing theme classes
            this.statusDiv.classList.remove('theme-dark', 'theme-light');
            this.controlsHint.classList.remove('theme-dark', 'theme-light');
            // Add current theme class
            this.statusDiv.classList.add(`theme-${theme}`);
            this.controlsHint.classList.add(`theme-${theme}`);
        }
        
        // AR UX state tracking
        this.arUXState = 'idle'; // idle, scanning, placing, placed

        // Check if renderer is ready
        if (!this.renderer) {
            console.error('Renderer not ready');
            return;
        }

        // Ensure WebXR is enabled on renderer
        if (!this.renderer.xr) {
            console.error('Renderer.xr not available');
            return;
        }

        if (!this.renderer.xr.enabled) {
            this.renderer.xr.enabled = true;
        }

        // Check XR support and show/hide AR button
        // Hide button initially - only show if AR is truly supported
        if (this.arButton) {
            this.arButton.classList.add('hidden');
            this.arButton.style.display = 'none';
        }
        
        if (navigator.xr) {
            navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
                this.arSupported = supported;
                if (supported && this.arButton) {
                    this.arButton.classList.remove('hidden');
                    this.arButton.style.display = '';
                    this.arButton.disabled = false;
                    console.log('[AR Button] Shown - AR is supported on this device');
                } else {
                    // AR not supported - keep button hidden
                    if (this.arButton) {
                        this.arButton.classList.add('hidden');
                        this.arButton.style.display = 'none';
                    }
                    console.log('[AR Button] Hidden - AR not supported on this device');
                }
            }).catch((error) => {
                console.warn('[AR Button] Error checking AR support:', error);
                this.arSupported = false;
                // Keep button hidden on error
                if (this.arButton) {
                    this.arButton.classList.add('hidden');
                    this.arButton.style.display = 'none';
                }
            });
        } else {
            // navigator.xr doesn't exist - AR not available
            this.arSupported = false;
            if (this.arButton) {
                this.arButton.classList.add('hidden');
                this.arButton.style.display = 'none';
            }
            console.log('[AR Button] Hidden - navigator.xr not available');
        }
        
        // Handle AR button click
        if (this.arButton) {
            this.arButton.onclick = async () => {
                if (this.renderer.xr.isPresenting) {
                    await this.xrSession?.end();
                    return;
                }
                
                try {
                    // Request session with proper features (model-viewer approach)
                    const sessionInit = {
                        requiredFeatures: ['hit-test'],
                        optionalFeatures: ['dom-overlay', 'light-estimation'],
                        domOverlay: { root: this.arOverlay }
                    };
                    
                    const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
                    this.xrSession = session;
                    
                    // Use 'local' reference space for both camera and hit-testing
                    this.renderer.xr.setReferenceSpaceType('local');
                    
                    await this.renderer.xr.setSession(session);
                    
                    // Update UI for AR mode
                    this.enterARMode();
                    
                    // Session handlers
                    this.onARStart();
                    
                    session.addEventListener('end', () => {
                        this.exitARMode();
                        this.onAREnd();
                    });
                    
                } catch (error) {
                    console.error('Failed to start AR:', error);
                    this.showARPrompt('Failed to start AR. Please try again.');
                }
            };
        }

        // Setup exit button
        if (this.exitARButton) {
            this.exitARButton.addEventListener('click', (e) => {
                // Prevent any other events from triggering
                e.preventDefault();
                e.stopPropagation();
                
                // Just call exitAR - it will set the flag internally
                this.exitAR();
            });
        }
        
        window.addEventListener('resize', () => this.onWindowResize());
    }

    /**
     * Enter AR mode - update UI (model-viewer style)
     */
    enterARMode() {
        // Hide AR button, show exit button
        if (this.arButton) this.arButton.classList.add('hidden');
        if (this.exitARButton) this.exitARButton.classList.add('visible');
        if (this.arOverlay) this.arOverlay.classList.add('active');
        if (this.controlsHint) this.controlsHint.classList.add('hidden');
        
        // Hide status (will show prompt instead)
        if (this.statusDiv) this.statusDiv.classList.add('hidden');
        
        // Start in scanning state - show hand animation
        this.arUXState = 'scanning';
        this.showHandPrompt();
        this.hideARPrompt();
    }

    /**
     * Exit AR mode - restore UI (model-viewer style)
     */
    exitARMode() {
        // Show AR button, hide exit button
        if (this.arButton) this.arButton.classList.remove('hidden');
        if (this.exitARButton) this.exitARButton.classList.remove('visible');
        if (this.arOverlay) this.arOverlay.classList.remove('active');
        if (this.controlsHint) this.controlsHint.classList.remove('hidden');
        
        // Move stats back to splat-viewer container for desktop mode (if they were in ar-overlay)
        if (this.stats && this.stats.dom) {
            // Find the custom element (splat-viewer) that contains this container
            let customElement = this.container;
            if (customElement.id === 'canvas-container') {
                customElement = customElement.parentElement;
            }
            while (customElement && customElement.tagName !== 'SPLAT-VIEWER' && customElement.parentElement) {
                customElement = customElement.parentElement;
            }
            const root = customElement || this.container;
            
            // Find the ar-overlay within this specific viewer instance
            const arOverlay = root.querySelector('#ar-overlay') || document.getElementById('ar-overlay');
            if (arOverlay && arOverlay.contains(this.stats.dom)) {
                root.appendChild(this.stats.dom);
                // Restore positioning styles
                this.stats.dom.style.position = 'absolute';
                this.stats.dom.style.top = '16px';
                this.stats.dom.style.left = '16px';
                console.log('📊 [STATS] Moved stats back to splat-viewer container for desktop mode');
            }
        }
        
        // Hide all prompts
        this.hideARPrompt();
        this.hideHandPrompt();
        
        // Reset state
        this.arUXState = 'idle';
        
        // Ensure splat is reset to origin when exiting AR (handles back navigation case)
        if (this.splatMesh) {
            this.applyTransformToMesh(this.splatMesh, 'desktop');
        }
        
        // Show status again (will auto-fade)
        this.updateStatus('AR session ended');
    }

    /**
     * Show hand prompt (scanning animation - model-viewer style)
     */
    showHandPrompt() {
        if (this.arHandPrompt) {
            this.arHandPrompt.classList.add('visible');
        }
    }

    /**
     * Hide hand prompt
     */
    hideHandPrompt() {
        if (this.arHandPrompt) {
            this.arHandPrompt.classList.remove('visible');
        }
    }

    /**
     * Show AR prompt message (model-viewer style floating prompt)
     */
    showARPrompt(message) {
        if (this.arPrompt) {
            this.arPrompt.textContent = message;
            this.arPrompt.classList.add('visible');
        }
    }

    /**
     * Hide AR prompt
     */
    hideARPrompt() {
        if (this.arPrompt) {
            this.arPrompt.classList.remove('visible');
        }
    }

    /**
     * Transition to "placing" state when floor is detected (model-viewer style)
     */
    onFloorDetected() {
        if (this.arUXState !== 'scanning') return;
        
        this.arUXState = 'placing';
        this.hideHandPrompt();
        this.showARPrompt('Tap to place');
    }

    /**
     * Transition to "placed" state after model is placed (model-viewer style)
     */
    onModelPlaced() {
        this.arUXState = 'placed';
        this.hideHandPrompt();
        this.showARPrompt('Drag to move • Pinch to scale • Twist to rotate');
        
        // Auto-hide prompt after 4 seconds (model-viewer behavior)
        setTimeout(() => {
            if (this.arUXState === 'placed') {
                this.hideARPrompt();
            }
        }, 4000);
    }

    async loadSplat(url) {
        try {
            this.updateStatus('Loading Gaussian splat...');

            if (!this.library || !this.library.SplatMesh) {
                throw new Error('Spark library not loaded');
            }

            if (!this.scene) {
                throw new Error('Scene not initialized');
            }

            // Remove existing splat mesh if any
            if (this.splatMesh) {
                this.scene.remove(this.splatMesh);
                // Dispose if SplatMesh has dispose method
                if (this.splatMesh.dispose && typeof this.splatMesh.dispose === 'function') {
                    this.splatMesh.dispose();
                }
                this.splatMesh = null;
            }

            // Create SplatMesh with Spark
            this.splatMesh = new this.library.SplatMesh({ url: url });
            
            // Hide mesh initially to prevent visible jump before transform is applied
            this.splatMesh.visible = false;
            
            // Add to scene
            this.scene.add(this.splatMesh);

            // Wait for load to complete
            // Spark's SplatMesh may load asynchronously - try multiple detection methods
            await new Promise((resolve, reject) => {
                let resolved = false;
                let pollInterval = null;
                
                const cleanup = () => {
                    if (pollInterval) {
                        clearInterval(pollInterval);
                        pollInterval = null;
                    }
                };

                const resolveOnce = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        console.log('SplatMesh load detected - resolving promise');
                        resolve();
                    }
                };

                const rejectOnce = (error) => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        console.error('SplatMesh load failed:', error);
                        reject(error || new Error('Failed to load splat file'));
                    }
                };

                // Method 1: Try event listeners (if Spark supports them)
                if (typeof this.splatMesh.addEventListener === 'function') {
                    const onLoad = () => {
                        console.log('SplatMesh load event fired');
                        resolveOnce();
                    };

                    const onError = (error) => {
                        console.error('SplatMesh error event fired:', error);
                        rejectOnce(error);
                    };

                    this.splatMesh.addEventListener('load', onLoad);
                    this.splatMesh.addEventListener('error', onError);
                }

                // Method 2: Poll for load completion
                // Check for various indicators that loading is complete
                let pollCount = 0;
                const maxPolls = 600; // 60 seconds at 100ms intervals
                
                pollInterval = setInterval(() => {
                    pollCount++;
                    
                    // Check if mesh has loaded (various indicators)
                    const hasGeometry = this.splatMesh && this.splatMesh.geometry !== undefined && this.splatMesh.geometry !== null;
                    const hasMaterial = this.splatMesh && this.splatMesh.material !== undefined && this.splatMesh.material !== null;
                    const isReady = this.splatMesh && (this.splatMesh.ready === true || this.splatMesh.loaded === true);
                    const hasUserDataLoaded = this.splatMesh && this.splatMesh.userData && this.splatMesh.userData.loaded === true;
                    
                    // Check if it's a Three.js object with children (might be a group)
                    const hasChildren = this.splatMesh && this.splatMesh.children && this.splatMesh.children.length > 0;
                    
                    // If any indicator suggests it's loaded, resolve
                    if (hasGeometry || hasMaterial || isReady || hasUserDataLoaded || hasChildren) {
                        console.log('SplatMesh appears loaded:', {
                            hasGeometry,
                            hasMaterial,
                            isReady,
                            hasUserDataLoaded,
                            hasChildren,
                            pollCount
                        });
                        resolveOnce();
                    } else if (pollCount >= maxPolls) {
                        // Timeout - check one more time before rejecting
                        cleanup();
                        if (hasGeometry || hasMaterial || hasChildren) {
                            console.warn('SplatMesh timeout but appears to have some properties - resolving anyway');
                            resolveOnce();
                        } else {
                            rejectOnce(new Error('Splat load timeout after 60 seconds. File may be too large, format not supported, or network issue. Check browser console for details.'));
                        }
                    }
                }, 100);
            });

            // Store in compatibility shim
            this.viewer.splatMesh = this.splatMesh;

            // Apply initial transform before showing
            this.applyTransformToMesh(this.splatMesh, 'desktop');

            // Show mesh after transform is applied
            this.splatMesh.visible = true;
            
            // Performance optimization: Configure SparkRenderer maxStdDev
            // Spark.js docs recommend Math.sqrt(5) for VR, or less than Math.sqrt(8) for better performance
            // Since we support AR, use Math.sqrt(5) for better VR/AR performance
            // The SparkRenderer is created automatically by SplatMesh, so we need to find it in the scene
            const configureSparkRenderer = () => {
                if (!this.library || !this.library.SparkRenderer) return;
                
                // Traverse scene to find SparkRenderer instances
                this.scene.traverse((child) => {
                    if (child instanceof this.library.SparkRenderer) {
                        // Set maxStdDev for better performance (especially for VR/AR)
                        // Math.sqrt(5) ≈ 2.24 is recommended for VR, perceptually very similar to default
                        child.maxStdDev = Math.sqrt(5);
                        console.log('SparkRenderer maxStdDev configured for performance:', child.maxStdDev);
                    }
                });
            };
            
            // Try to configure immediately, and also after first render when SparkRenderer is created
            configureSparkRenderer();
            
            // Reset flag - animation loop will set it to true after first render
            this._splatFirstRenderComplete = false;

            // Force a render to ensure splat is visible before showing success message
            // This will also trigger SparkRenderer creation, so configure after render
            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
                // Configure again after render in case SparkRenderer was just created
                requestAnimationFrame(() => configureSparkRenderer());
            }
            
            // Don't show success message here - wait for animation loop to confirm first render

            // Setup OrbitControls for desktop/non-AR mode first
            this.setupOrbitControls();

            // Re-apply camera transform after OrbitControls setup to ensure correct positioning
            // This ensures camera position and lookAt are set correctly and OrbitControls target is at origin
            this.applyCameraTransform();

            // Ensure WebXR is enabled on the renderer
            if (this.renderer) {
                this.renderer.xr.enabled = true;
                console.log('WebXR enabled on renderer');
            }

        } catch (error) {
            console.error('Error loading splat:', error);
            this.updateStatus('Error loading splat: ' + error.message);
            
            // Clean up on error
            if (this.splatMesh) {
                this.scene.remove(this.splatMesh);
                this.splatMesh = null;
                this.viewer.splatMesh = null;
            }
            
            throw error;
        }
    }

    async onARStart() {
        const session = this.renderer.xr.getSession();
        if (!session) {
            console.warn('⚠️ [AR START] AR session not available');
            return;
        }

        // Reset exit flag in case it was left in a bad state
        this._isExitingAR = false;
        
        this.xrSession = session;
        
        // Performance optimization: Pause all other viewers when this one enters AR
        // Only one viewer can be in AR at a time, so pause others to save resources
        for (const viewer of activeViewers) {
            if (viewer !== this && !viewer._isPaused) {
                viewer.pauseRendering();
                console.log('Paused other viewer for AR performance');
            }
        }
        
        // Log session capabilities (for debugging)
        // AR session started
        
        // Initialize plane detection if available (ARCore on Android)
        if (session.enabledFeatures?.includes('plane-detection') && window.XRPlanes) {
            this.initializePlaneDetection();
        } else {
            // Plane detection not available - using hit-test fallback
            this.xrPlanes = null;
        }

        // Store camera state before entering AR
        this.preARCameraState = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            rotation: this.camera.rotation.clone()
        };

        // Hide splat until placed
        if (this.splatMesh) {
            this.splatMesh.visible = false;
        }

        // Disable OrbitControls in AR mode (they interfere with AR gestures)
        if (this.orbitControls) {
            this.orbitControls.enabled = false;
        }

        // Stop desktop animation loop - AR frame loop will take over
        // The setAnimationLoop call in setupARFrameLoop will replace it, but
        // we ensure desktop loop doesn't run by checking isPresenting
        
        // Initialize hit testing with local-floor
        await this.initializeHitTest();

        // Ensure stats are visible in AR mode - move to ar-overlay if not already there
        // This is required for dom-overlay feature to show DOM elements in AR
        if (this.stats && this.stats.dom) {
            // Find the ar-overlay within this specific viewer instance
            let customElement = this.container;
            if (customElement.id === 'canvas-container') {
                customElement = customElement.parentElement;
            }
            while (customElement && customElement.tagName !== 'SPLAT-VIEWER' && customElement.parentElement) {
                customElement = customElement.parentElement;
            }
            const root = customElement || this.container;
            const arOverlay = root.querySelector('#ar-overlay') || document.getElementById('ar-overlay');
            
            if (arOverlay && !arOverlay.contains(this.stats.dom)) {
                // Move stats to ar-overlay for AR mode visibility
                // In AR mode, use fixed positioning relative to viewport
                arOverlay.appendChild(this.stats.dom);
                this.stats.dom.style.position = 'fixed';
                this.stats.dom.style.top = '16px';
                this.stats.dom.style.left = '16px';
                console.log('📊 [STATS] Moved stats to ar-overlay for AR mode');
            }
            this.stats.dom.style.visibility = 'visible';
            this.stats.dom.style.display = 'block';
            this.stats.dom.style.zIndex = '10001';
            console.log('📊 [STATS] Ensuring stats visible in AR mode');
        }
        
        // Setup AR frame loop (this replaces the desktop loop)
        this.setupARFrameLoop();

        // Setup touch input for placement
        this.setupTransientHitTest();
        this.setupARTapEvent();
        
        // Note: Gestures are handled in processXRInput() in the frame loop
        // No need for separate gesture controls setup

        // Update UI
        if (this.arButton) {
            this.arButton.classList.add('hidden');
        }
        const exitButton = document.getElementById('exit-ar-btn');
        if (exitButton) {
            exitButton.classList.remove('hidden');
        }

        // Start in scanning state - show hand animation and prompt
        this.arUXState = 'scanning';
        this.showHandPrompt();
        this.showARPrompt('Move your phone to scan the floor');
    }

    async onAREnd() {
        // Note: exitAR() handles cleanup, but it may have already been called
        // if user clicked the exit button. Only call if not already exiting.
        if (!this._isExitingAR) {
            this.exitAR();
        } else {
            // Even if exitAR() was already called, ensure splat is reset to origin
            // This handles the case where back navigation ends the session
            if (this.splatMesh) {
                this.applyTransformToMesh(this.splatMesh, 'desktop');
            }
        }
    }

    async enterAR() {
        // Legacy method - ARButton handles session creation now
        // This method is kept for backward compatibility but should not be called directly
        // ARButton will call onARStart() when session starts
        console.warn('enterAR() is deprecated. ARButton handles session creation automatically.');
        
        if (!this.renderer) {
            this.updateStatus('Viewer not ready for AR');
            return;
        }

        // If we get here, try to manually start AR (fallback)
        // But ARButton should handle this, so this is just for compatibility
        try {
            // Store camera state before entering AR
            if (this.camera) {
                this.preARCameraState = {
                    position: this.camera.position.clone(),
                    quaternion: this.camera.quaternion.clone(),
                    rotation: this.camera.rotation.clone()
                };
            }

            // Create or get overlay element for dom-overlay feature
            let overlayElement = document.getElementById('ar-overlay');
            if (!overlayElement) {
                overlayElement = document.createElement('div');
                overlayElement.id = 'ar-overlay';
                overlayElement.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1000;';
                document.body.appendChild(overlayElement);
            }

            // Request session with hit-test required (like model-viewer)
            // See: https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/three-components/ARRenderer.ts
            let session = null;
            const sessionInit = {
                requiredFeatures: ['hit-test'],
                optionalFeatures: ['local-floor', 'dom-overlay', 'light-estimation'],  // local-floor for stable tracking
                domOverlay: { root: overlayElement }
            };
            
            try {
                session = await navigator.xr.requestSession('immersive-ar', sessionInit);
            } catch (error) {
                // Fallback: try with hit-test as optional
                const fallbackInit = {
                    requiredFeatures: [],
                    optionalFeatures: ['hit-test', 'local-floor', 'dom-overlay', 'light-estimation'],
                    domOverlay: { root: overlayElement }
                };
                session = await navigator.xr.requestSession('immersive-ar', fallbackInit);
            }

            this.xrSession = session;
            
            // Set reference space type - prefer local-floor for floor-relative coordinates
            // With local-floor: Y=0 is at floor level (easier math)
            // With local: Y=0 is at device start position
            const hasLocalFloor = session.enabledFeatures && 
                (Array.from(session.enabledFeatures).includes('local-floor') || 
                 session.enabledFeatures.has?.('local-floor'));
            
            // Use local-floor if available, otherwise local
            this.renderer.xr.setReferenceSpaceType(hasLocalFloor ? 'local-floor' : 'local');
            
            this.renderer.xr.setSession(session);
            
            // Track which features are actually supported
            // enabledFeatures is a FrozenArray, convert to Set for easier checking
            let supportedFeatures = new Set();
            if (session.enabledFeatures) {
                // Handle both array-like and Set-like objects
                if (Array.isArray(session.enabledFeatures) || session.enabledFeatures.length !== undefined) {
                    supportedFeatures = new Set(Array.from(session.enabledFeatures));
                } else if (session.enabledFeatures instanceof Set) {
                    supportedFeatures = session.enabledFeatures;
                } else {
                    // Fallback: try to iterate if it's iterable
                    try {
                        supportedFeatures = new Set(session.enabledFeatures);
                    } catch (e) {
                        console.warn('Could not convert enabledFeatures to Set:', e);
                    }
                }
            }
            // Call onARStart to handle the rest (simplified)
            // onARStart will handle hit-test initialization, frame loop, and UI updates
            await this.onARStart();

            // Session end is handled by ARButton's sessionend event
        } catch (error) {
            console.error('Error entering AR:', error);
            
            // Provide specific error messages based on error type
            let errorMessage = 'Error entering AR: ';
            if (error.name === 'NotSupportedError') {
                errorMessage = 'AR mode is not supported on this device or browser. Required features are not available.';
            } else if (error.name === 'SecurityError') {
                errorMessage = 'AR mode requires permissions. Please ensure the site has xr-spatial-tracking permissions policy enabled.';
            } else if (error.name === 'InvalidStateError') {
                errorMessage = 'AR session is already active or being set up.';
            } else {
                errorMessage += error.message || 'Unknown error occurred';
            }
            
            this.updateStatus(errorMessage);
        }
    }

    initializePlaneDetection() {
        // Initialize ARCore plane detection using Three.js XRPlanes
        if (!window.XRPlanes || !this.renderer || !this.scene) return;

        try {
            this.xrPlanes = new window.XRPlanes(this.renderer);
            this.scene.add(this.xrPlanes);
        } catch (error) {
            this.xrPlanes = null;
        }
    }

    async initializeHitTest() {
        if (!this.xrSession || !this.renderer) return;

        // Check if session supports hit-test
        if (!this.xrSession.requestHitTestSource) {
            this.hitTestSource = null;
            this.transientHitTestSource = null;
            return;
        }

        try {
            // Use Three.js's reference space for hit-testing (model-viewer approach)
            // Same reference space for both camera and hit-testing = no coordinate mismatch
            let referenceSpace = this.renderer.xr.getReferenceSpace();
            
            // If Three.js hasn't set up its reference space yet, create one
            if (!referenceSpace) {
                try {
                    referenceSpace = await this.xrSession.requestReferenceSpace('local');
                } catch (error) {
                    this.hitTestSource = null;
                    this.initialHitSource = null;
                    this.transientHitTestSource = null;
                    return;
                }
            }

            // Create initial hit source with offset ray (for automatic floor detection)
            // This uses viewer space with a slightly downward-pointing ray (like model-viewer)
            try {
                const viewerRefSpace = await this.xrSession.requestReferenceSpace('viewer');
                const HIT_ANGLE_DEG = 5; // 5 degrees down from camera forward (more centered)
                const radians = HIT_ANGLE_DEG * Math.PI / 180;
                
                // Create offset ray pointing slightly down at 5° angle (centered on screen)
                const offsetRay = new XRRay(
                    new DOMPoint(0, 0, 0),
                    {x: 0, y: -Math.sin(radians), z: -Math.cos(radians)}
                );
                
                this.initialHitSource = await this.xrSession.requestHitTestSource({
                    space: viewerRefSpace,
                    offsetRay: offsetRay
                });
            } catch (error) {
                this.initialHitSource = null;
            }

            // Create hit test source for reticle/placement
            try {
                this.hitTestSource = await this.xrSession.requestHitTestSource({ 
                    space: referenceSpace 
                });
            } catch (error) {
                this.hitTestSource = null;
            }

            // Create transient hit test for touch input
            if (this.xrSession.requestHitTestSourceForTransientInput) {
                try {
                    this.transientHitTestSource = await this.xrSession.requestHitTestSourceForTransientInput({
                        profile: 'generic-touchscreen',
                        offsetRay: new XRRay(new DOMPoint(0, 0, 0), { x: 0, y: 0, z: -1, w: 0 })
                    });
                } catch (error) {
                    try {
                        this.transientHitTestSource = await this.xrSession.requestHitTestSourceForTransientInput({
                            profile: 'generic-touchscreen'
                        });
                    } catch (error2) {
                        this.transientHitTestSource = null;
                    }
                }
            } else {
                this.transientHitTestSource = null;
            }

            // Create AR reticle for visual feedback
            this.createARReticle();
        } catch (error) {
            // Continue AR mode even if hit-test fails - we'll use alternative placement
            this.hitTestSource = null;
            this.initialHitSource = null;
            this.transientHitTestSource = null;
        }
    }

    /**
     * Get hit point from hit test result, validating surface normal (model-viewer approach)
     * Returns null if the surface normal doesn't indicate a floor (Y component > 0.75)
     * 
     * CRITICAL FIX: Use the SAME reference space that Three.js uses for the camera.
     * Model-viewer uses 'local' space for both camera and hit-testing.
     * Using different reference spaces causes coordinate mismatch and visual offset.
     */
    getHitPoint(hitResult) {
        // Use Three.js's reference space to match the camera coordinate system
        // This ensures the splat position and camera position are in the same space
        const refSpace = this.renderer.xr.getReferenceSpace();
        if (!refSpace) return null;
        
        const pose = hitResult.getPose(refSpace);
        if (!pose || !pose.transform) {
            return null;
        }
        
        const hitMatrix = new window.THREE.Matrix4().fromArray(pose.transform.matrix);
        
        // Check that the y-coordinate of the normal is large enough that the normal
        // is pointing up for floor placement (model-viewer approach)
        // hitMatrix.elements[5] is the Y component of the normal vector (second row, second column)
        // For a floor, this should be > 0.75 (pointing up)
        const normalY = hitMatrix.elements[5];
        if (normalY <= 0.75) {
            // Surface is not pointing up enough - likely a wall or invalid surface
            return null;
        }
        
        // Extract hit position
        const hitPosition = new window.THREE.Vector3();
        hitPosition.setFromMatrixPosition(hitMatrix);
        
        // Floor detected (using same ref space as camera - model-viewer approach)
        
        return hitPosition;
    }

    /**
     * Get the bounding box of the splat mesh in local space (model-viewer approach)
     * Returns the bounding box in local space (relative to mesh origin)
     * This is used to calculate the offset from mesh origin to bottom of model
     */
    getSplatBoundingBoxLocal() {
        if (!this.splatMesh) return null;
        
        // Compute bounding box accounting for scale and rotation
        // We need to transform the bounding box to account for rotation
        // but keep it in a space where we can calculate the bottom offset
        
        const box = new window.THREE.Box3();
        
        // Try to get bounding box from the mesh geometry (local space)
        if (this.splatMesh.geometry) {
            if (!this.splatMesh.geometry.boundingBox) {
                this.splatMesh.geometry.computeBoundingBox();
            }
            if (this.splatMesh.geometry.boundingBox) {
                // Copy local bounding box (before any transforms)
                box.copy(this.splatMesh.geometry.boundingBox);
                
                // Apply scale first
                const scale = this.splatMesh.scale;
                if (scale && (scale.x !== 1 || scale.y !== 1 || scale.z !== 1)) {
                    box.min.x *= scale.x;
                    box.min.y *= scale.y;
                    box.min.z *= scale.z;
                    box.max.x *= scale.x;
                    box.max.y *= scale.y;
                    box.max.z *= scale.z;
                }
                
                // Apply rotation to bounding box
                // Rotation can change which corner is the "bottom"
                // We need to transform all 8 corners of the box and find the new min/max
                if (this.splatMesh.quaternion && !this.splatMesh.quaternion.equals(new window.THREE.Quaternion())) {
                    const corners = [
                        new window.THREE.Vector3(box.min.x, box.min.y, box.min.z),
                        new window.THREE.Vector3(box.max.x, box.min.y, box.min.z),
                        new window.THREE.Vector3(box.min.x, box.max.y, box.min.z),
                        new window.THREE.Vector3(box.max.x, box.max.y, box.min.z),
                        new window.THREE.Vector3(box.min.x, box.min.y, box.max.z),
                        new window.THREE.Vector3(box.max.x, box.min.y, box.max.z),
                        new window.THREE.Vector3(box.min.x, box.max.y, box.max.z),
                        new window.THREE.Vector3(box.max.x, box.max.y, box.max.z)
                    ];
                    
                    // Transform all corners by rotation
                    corners.forEach(corner => {
                        corner.applyQuaternion(this.splatMesh.quaternion);
                    });
                    
                    // Find new min/max after rotation
                    box.makeEmpty();
                    corners.forEach(corner => {
                        box.expandByPoint(corner);
                    });
                }
            }
        } else {
            // Fallback: use a default bounding box if geometry not available
            box.setFromCenterAndSize(
                new window.THREE.Vector3(0, 0, 0),
                new window.THREE.Vector3(1, 1, 1)
            );
        }
        
        return box;
    }

    /**
     * Get the bounding box of the splat mesh in world space (for visualization)
     * Returns the bounding box in world space, accounting for current position, rotation, and scale
     */
    getSplatBoundingBox() {
        if (!this.splatMesh) return null;
        
        // Ensure matrix is up to date
        this.splatMesh.updateMatrixWorld(true);
        
        // Get local bounding box first
        const localBox = this.getSplatBoundingBoxLocal();
        if (!localBox) {
            // Fallback: return null if we can't compute local bounding box
            return null;
        }
        
        // Transform local bounding box to world space
        // We need to transform all 8 corners of the box
        const corners = [
            new window.THREE.Vector3(localBox.min.x, localBox.min.y, localBox.min.z),
            new window.THREE.Vector3(localBox.max.x, localBox.min.y, localBox.min.z),
            new window.THREE.Vector3(localBox.min.x, localBox.max.y, localBox.min.z),
            new window.THREE.Vector3(localBox.max.x, localBox.max.y, localBox.min.z),
            new window.THREE.Vector3(localBox.min.x, localBox.min.y, localBox.max.z),
            new window.THREE.Vector3(localBox.max.x, localBox.min.y, localBox.max.z),
            new window.THREE.Vector3(localBox.min.x, localBox.max.y, localBox.max.z),
            new window.THREE.Vector3(localBox.max.x, localBox.max.y, localBox.max.z)
        ];
        
        // Transform corners to world space
        corners.forEach(corner => {
            corner.applyMatrix4(this.splatMesh.matrixWorld);
        });
        
        // Create world-space bounding box from transformed corners
        const worldBox = new window.THREE.Box3();
        worldBox.makeEmpty();
        corners.forEach(corner => {
            worldBox.expandByPoint(corner);
        });
        
        return worldBox;
    }

    /**
     * Update reticle position based on floor detection (model-viewer approach)
     * Called in frame loop when initialHitSource has a hit
     * Does NOT auto-place - just shows the reticle. User must tap to place.
     */
    moveToFloor(frame) {
        if (!this.initialHitSource || !frame) {
            return;
        }
        
        const hitTestResults = frame.getHitTestResults(this.initialHitSource);
        if (hitTestResults.length === 0) {
            return;
        }
        
        const hit = hitTestResults[0];
        const hitPoint = this.getHitPoint(hit);
        if (!hitPoint) {
            // Hit point validation failed (not a floor surface)
            return;
        }
        
        // Floor detected - update reticle position
        if (this.reticle) {
            this.reticle.visible = true;
            this.reticle.position.copy(hitPoint);
            // Keep rotation fixed (flat on floor) - don't apply hit rotation
            // The reticle is already rotated -90° on X to lie flat
        }
        
        // Store pending hit for tap placement
        this.pendingHitPosition = hitPoint.clone();
        const refSpace = this.renderer.xr.getReferenceSpace();
        if (refSpace) {
            const hitPose = hit.getPose(refSpace);
            if (hitPose && hitPose.transform) {
                const hitMatrix = new window.THREE.Matrix4().fromArray(hitPose.transform.matrix);
                this.pendingHitQuaternion = new window.THREE.Quaternion();
                this.pendingHitQuaternion.setFromRotationMatrix(hitMatrix);
            }
        }
        
        // Update UX state - floor found, show "tap to place" prompt
        if (this.arUXState === 'scanning') {
            this.onFloorDetected();
        }
    }

    createARReticle() {
        if (!this.scene || !window.THREE) return;
        
        // Create a reticle mesh for AR placement feedback
        // Match manipulation ring styling: thin ring, light gray, semi-transparent
        const geometry = new window.THREE.RingGeometry(0.23, 0.25, 64);
        const material = new window.THREE.MeshBasicMaterial({ 
            color: 0xcccccc, // Light gray (matches manipulation ring)
            side: window.THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            depthTest: false
        });
        this.reticle = new window.THREE.Mesh(geometry, material);
        
        // Rotate to lie flat on ground (RingGeometry is in XY plane, we need XZ)
        this.reticle.rotation.x = -Math.PI / 2;
        
        this.reticle.renderOrder = 999; // Render on top
        this.reticle.visible = false;
        this.scene.add(this.reticle);
        
        // Create manipulation feedback ring (model-viewer style)
        this.createManipulationRing();
        
        // Create debug floor plane
        this.createDebugFloorPlane();
        
        // Create placement box (model-viewer approach)
        this.createPlacementBox();
    }

    /**
     * Create the manipulation feedback ring (model-viewer style)
     * This ring appears under the splat during drag/rotate/scale interactions
     */
    createManipulationRing() {
        if (!this.scene || !window.THREE) return;
        
        // Create a thin ring for manipulation feedback
        // Inner radius 0.23, outer radius 0.25 = thin 0.02 width ring
        const geometry = new window.THREE.RingGeometry(0.23, 0.25, 64);
        const material = new window.THREE.MeshBasicMaterial({ 
            color: 0xcccccc, // Very light gray
            side: window.THREE.DoubleSide,
            transparent: true,
            opacity: 0,
            depthTest: false
        });
        
        this.manipulationRing = new window.THREE.Mesh(geometry, material);
        this.manipulationRing.rotation.x = -Math.PI / 2; // Lie flat on ground
        this.manipulationRing.renderOrder = 1000; // Render on top
        this.manipulationRing.visible = false;
        this.scene.add(this.manipulationRing);
        
        // Track fade animation
        this.manipulationRingFadeStartTime = 0;
    }

    /**
     * Show manipulation feedback ring under the splat (model-viewer style)
     * Called when user starts interacting with the splat
     */
    showManipulationFeedback() {
        if (!this.manipulationRing || !this.splatMesh) return;
        
        console.log('🟢 [RING] SHOW - gesture started');
        
        // Cancel any pending hide timeout
        if (this.manipulationRingHideTimeout) {
            console.log('🟢 [RING] Cancelled pending hide timeout');
            clearTimeout(this.manipulationRingHideTimeout);
            this.manipulationRingHideTimeout = null;
        }
        
        // Cancel any ongoing fade
        if (this.manipulationRingFadeStartTime > 0) {
            console.log('🟢 [RING] Cancelled ongoing fade');
        }
        this.manipulationRingFadeStartTime = 0;
        
        // Position ring at splat's base
        this.manipulationRing.position.set(
            this.splatMesh.position.x,
            this.splatMesh.position.y + 0.002, // Slightly above floor to avoid z-fighting
            this.splatMesh.position.z
        );
        
        // Scale ring based on splat size
        const boundingBox = this.getSplatBoundingBox();
        if (boundingBox) {
            const size = boundingBox.max.clone().sub(boundingBox.min);
            const maxSize = Math.max(size.x, size.z) * 0.6;
            const ringScale = Math.max(1, maxSize);
            this.manipulationRing.scale.set(ringScale, ringScale, 1);
        }
        
        // Show immediately
        this.manipulationRing.visible = true;
        this.manipulationRing.material.opacity = 0.6;
    }

    /**
     * Update manipulation feedback ring position during interaction
     * Call this every frame while interacting
     */
    updateManipulationFeedback() {
        if (!this.manipulationRing || !this.manipulationRing.visible || !this.splatMesh) return;
        
        // Don't update position while fading out
        if (this.manipulationRingFadeStartTime > 0) return;
        
        // Follow the splat's position
        this.manipulationRing.position.set(
            this.splatMesh.position.x,
            this.splatMesh.position.y + 0.002,
            this.splatMesh.position.z
        );
        
        // Update scale if splat is being scaled
        const boundingBox = this.getSplatBoundingBox();
        if (boundingBox) {
            const size = boundingBox.max.clone().sub(boundingBox.min);
            const maxSize = Math.max(size.x, size.z) * 0.6;
            const ringScale = Math.max(1, maxSize);
            this.manipulationRing.scale.set(ringScale, ringScale, 1);
        }
    }

    /**
     * Hide manipulation feedback ring with fade out (model-viewer style)
     * Called when user stops interacting with the splat
     * Uses a delay to avoid flicker from rapid gesture start/end
     */
    hideManipulationFeedback() {
        if (!this.manipulationRing || !this.manipulationRing.visible) {
            console.log('🔴 [RING] HIDE called but ring not visible, ignoring');
            return;
        }
        
        console.log('🔴 [RING] HIDE - gesture ended, starting 100ms delay');
        
        // Use a short delay before starting fade to avoid flicker
        // If a new gesture starts within this time, the timeout is cancelled
        this.manipulationRingHideTimeout = setTimeout(() => {
            console.log('🔴 [RING] Delay complete, starting fade');
            this.manipulationRingHideTimeout = null;
            if (this.manipulationRing && this.manipulationRing.visible) {
                this.manipulationRingFadeStartTime = performance.now();
                console.log('🔴 [RING] Fade started at:', this.manipulationRingFadeStartTime);
            }
        }, 100); // 100ms delay before fade starts
    }

    /**
     * Update manipulation ring fade animation (called from AR frame loop)
     */
    updateManipulationRingFade() {
        if (!this.manipulationRing) return;
        if (this.manipulationRingFadeStartTime <= 0) return;
        
        const elapsed = performance.now() - this.manipulationRingFadeStartTime;
        const fadeDuration = 300; // 300ms fade
        const progress = Math.min(1, elapsed / fadeDuration);
        const opacity = 0.6 * (1 - progress);
        
        this.manipulationRing.material.opacity = opacity;
        
        // Log every 10% progress
        if (Math.floor(progress * 10) !== Math.floor((progress - 0.033) * 10)) {
            console.log('🔴 [RING] Fade:', Math.round(progress * 100) + '%', 'opacity:', opacity.toFixed(2));
        }
        
        if (progress >= 1) {
            this.manipulationRing.visible = false;
            this.manipulationRing.material.opacity = 0;
            this.manipulationRingFadeStartTime = 0;
            console.log('🔴 [RING] Fade complete - ring hidden');
        }
    }
    
    /**
     * Update pivot position with smooth interpolation to goalPosition (model-viewer approach)
     * Since the splat's pivot is already at its base, no offset adjustment is needed
     */
    updatePivotPosition(delta) {
        if (!this.splatMesh || !this.splatPlaced) {
            return;
        }
        
        const position = this.splatMesh.position;
        const goal = this.goalPosition;
        
        // Calculate bounding radius for damper normalization
        const boundingBox = this.getSplatBoundingBox();
        const boundingRadius = boundingBox ? 
            boundingBox.max.clone().sub(boundingBox.min).length() / 2 : 1;
        
        // Pivot is at base of splat, so position directly matches goal (no offset needed)
        const targetX = goal.x;
        const targetY = goal.y;
        const targetZ = goal.z;
        
        // Smoothly interpolate to target position
        if (!position.equals(new window.THREE.Vector3(targetX, targetY, targetZ))) {
            let x = position.x;
            let y = position.y;
            let z = position.z;
            
            x = this.xDamper.update(x, targetX, delta, boundingRadius);
            y = this.yDamper.update(y, targetY, delta, boundingRadius);
            z = this.zDamper.update(z, targetZ, delta, boundingRadius);
            
            position.set(x, y, z);
            
            this.splatMesh.updateMatrixWorld(true);
            
            // Update placement box
            this.updatePlacementBox();
            
            // Check if placement animation is complete
            const distance = position.distanceTo(new window.THREE.Vector3(targetX, targetY, targetZ));
            if (distance < 0.001) {
                if (!this.placementComplete) {
                    this.placementComplete = true;
                    if (this.placementBox) {
                        this.placementBox.visible = false;
                    }
                    // Placement animation complete
                }
            }
        } else if (!this.placementComplete) {
            // Position already matches target, mark as complete
            this.placementComplete = true;
            if (this.placementBox) {
                this.placementBox.visible = false;
            }
        }
    }

    /**
     * Create a PlacementBox for visual feedback (model-viewer approach)
     * Shows where the splat will be placed
     */
    createPlacementBox() {
        if (!this.scene || !window.THREE) return;
        
        // Remove existing placement box if any
        if (this.placementBox) {
            this.scene.remove(this.placementBox);
            this.placementBox = null;
        }
        
        // Create a simple wireframe box to show placement area
        // This is a simplified version of model-viewer's PlacementBox
        const boxGeometry = new window.THREE.RingGeometry(0.1, 0.15, 32);
        const boxMaterial = new window.THREE.MeshBasicMaterial({
            color: 0xffffff,
            wireframe: false,
            side: window.THREE.DoubleSide,
            transparent: true,
            opacity: 0.6
        });
        
        this.placementBox = new window.THREE.Mesh(boxGeometry, boxMaterial);
        
        // Rotate to be horizontal (floor placement)
        this.placementBox.rotation.x = -Math.PI / 2;
        
        // Initially hide it
        this.placementBox.visible = false;
        this.scene.add(this.placementBox);
        
    }

    /**
     * Update PlacementBox position and size based on splat bounding box
     */
    updatePlacementBox() {
        if (!this.placementBox || !this.splatMesh || !this.splatPlaced) {
            if (this.placementBox) {
                this.placementBox.visible = false;
            }
            return;
        }
        
        // Get bounding box to determine placement area
        const boundingBox = this.getSplatBoundingBox();
        if (!boundingBox) {
            this.placementBox.visible = false;
            return;
        }
        
        // Position at the center of the bounding box (XZ plane)
        this.placementBox.position.set(
            this.splatMesh.position.x,
            boundingBox.min.y, // At the bottom of the splat
            this.splatMesh.position.z
        );
        
        // Scale based on bounding box size
        const size = boundingBox.max.clone().sub(boundingBox.min);
        const maxSize = Math.max(size.x, size.z);
        this.placementBox.scale.set(maxSize * 1.2, maxSize * 1.2, 1); // Slightly larger than the splat
        
        // Show placement box during placement animation
        if (!this.placementComplete) {
            this.placementBox.visible = true;
        } else {
            this.placementBox.visible = false;
        }
    }

    /**
     * Create a debug wireframe plane to visualize the estimated floor position
     * Hidden by default for production - set this.showDebugFloor = true to enable
     */
    createDebugFloorPlane() {
        // Debug floor plane disabled for production (model-viewer style clean UX)
        // Set this.showDebugFloor = true before AR session to enable
        if (!this.showDebugFloor) return;
        
        if (!this.scene || !window.THREE) return;
        
        // Remove existing debug plane if any
        if (this.debugFloorPlane) {
            this.scene.remove(this.debugFloorPlane);
            this.debugFloorPlane = null;
        }
        
        // Create a large wireframe plane (5m x 5m) to show the floor
        const planeGeometry = new window.THREE.PlaneGeometry(5, 5, 10, 10);
        const planeMaterial = new window.THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            side: window.THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false
        });
        
        this.debugFloorPlane = new window.THREE.Mesh(planeGeometry, planeMaterial);
        this.debugFloorPlane.rotation.x = -Math.PI / 2;
        this.debugFloorPlane.renderOrder = 999;
        this.debugFloorPlane.userData = { wasVisible: false };
        
        // Initially hide it - will be shown when floor is detected
        this.debugFloorPlane.visible = false;
        this.scene.add(this.debugFloorPlane);
        
        // Debug floor plane created (only shown if showDebugFloor is true)
        if (this.showDebugFloor) console.log('[DEBUG] Floor plane created', {
            inScene: this.scene.children.includes(this.debugFloorPlane),
            visible: this.debugFloorPlane.visible,
            position: this.debugFloorPlane.position.toArray()
        });
    }

    /**
     * Update debug floor plane position to show where the splat's base is
     * Since the splat's pivot is at its base, the plane should be at the splat's Y position
     */
    updateDebugFloorPlaneAtSplat() {
        // Skip if debug floor is disabled
        if (!this.showDebugFloor) return;
        
        if (!this.debugFloorPlane) {
            this.createDebugFloorPlane();
        }
        
        if (!this.debugFloorPlane) return;
        
        // Position at splat's position (pivot is at base, so splat.y IS the floor)
        if (this.splatMesh && this.splatPlaced) {
            this.debugFloorPlane.position.set(
                this.splatMesh.position.x,
                this.splatMesh.position.y,
                this.splatMesh.position.z
            );
            this.debugFloorPlane.visible = true;
            this.debugFloorPlane.updateMatrixWorld(true);
            
            // Log when plane becomes visible (debug only)
            if (!this.debugFloorPlane.userData.wasVisible) {
                console.log('[DEBUG] Floor plane visible at:', this.debugFloorPlane.position.y.toFixed(3));
                this.debugFloorPlane.userData.wasVisible = true;
            }
            
            // Occasional debug logging
            if (Math.random() < 0.02) {
                console.log('[DEBUG] Plane Y:', this.debugFloorPlane.position.y.toFixed(3),
                    'Splat Y:', this.splatMesh.position.y.toFixed(3),
                    'Goal Y:', this.goalPosition.y.toFixed(3)
                );
            }
        } else if (this.goalPosition && !this.goalPosition.equals(new window.THREE.Vector3())) {
            // Before splat is placed, show at goal position
            this.debugFloorPlane.position.copy(this.goalPosition);
            this.debugFloorPlane.visible = true;
            this.debugFloorPlane.updateMatrixWorld(true);
        } else {
            this.debugFloorPlane.visible = false;
        }
    }

    /**
     * Track phone/camera position relative to detected floor for debugging
     * This helps identify if there's an offset between ARCore's floor detection and reality
     */
    trackFloorOffset(frame) {
        // Disabled for production - only enable for debugging
        if (!this.showDebugFloor) return;
        
        if (!frame) return;
        
        const referenceSpace = this.renderer.xr.getReferenceSpace();
        if (!referenceSpace) return;
        
        // Get viewer (phone/camera) pose
        const viewerPose = frame.getViewerPose(referenceSpace);
        if (!viewerPose) return;
        
        const cameraY = viewerPose.transform.position.y;
        
        // Get floor Y from hit test if available
        let floorY = null;
        let hitSource = 'none';
        
        // Try to get floor from current hit test
        if (this.hitTestSource) {
            try {
                const results = frame.getHitTestResults(this.hitTestSource);
                if (results.length > 0) {
                    const pose = results[0].getPose(referenceSpace);
                    if (pose) {
                        floorY = pose.transform.position.y;
                        hitSource = 'hit-test';
                        this.lastHitFloorY = floorY;
                    }
                }
            } catch (e) { /* ignore */ }
        }
        
        // Use last known floor Y if no current hit
        if (floorY === null && this.lastHitFloorY !== null) {
            floorY = this.lastHitFloorY;
            hitSource = 'cached';
        }
        
        // Use reticle position if available
        if (floorY === null && this.reticle && this.reticle.visible) {
            floorY = this.reticle.position.y;
            hitSource = 'reticle';
        }
        
        // Use goal position if splat is placed
        if (floorY === null && this.splatPlaced && this.goalPosition) {
            floorY = this.goalPosition.y;
            hitSource = 'goalPosition';
        }
        
        // Throttle logging (every ~60 frames = ~1 second)
        this.floorTrackingLogInterval++;
        if (this.floorTrackingLogInterval >= 60) {
            this.floorTrackingLogInterval = 0;
            
            if (floorY !== null) {
                const estimatedHeight = cameraY - floorY;  // Positive = camera above floor
                
                // Check if camera is impossibly below the floor (tracking issue)
                const isTrackingBroken = estimatedHeight < -0.1;  // Allow small margin
                
                // Check if height makes sense (between 0.3m and 2.5m)
                const isHeightNormal = estimatedHeight > 0.3 && estimatedHeight < 2.5;
                
                console.log('📱 [FLOOR TRACKING]', {
                    cameraY: cameraY.toFixed(3),
                    floorY: floorY.toFixed(3),
                    estimatedHeight: estimatedHeight.toFixed(3) + 'm',
                    source: hitSource,
                    coordMatch: '✅ Same ref space as camera',
                    status: isTrackingBroken 
                        ? '❌ TRACKING ERROR: Camera below floor!' 
                        : !isHeightNormal ? '⚠️ Unusual height' 
                        : '✅ Normal'
                });
            } else {
                console.log('📱 [FLOOR TRACKING] No floor data available yet', {
                    cameraY: cameraY.toFixed(3),
                    hitTestSource: !!this.hitTestSource,
                    reticleVisible: this.reticle?.visible
                });
            }
        }
    }

    updateReticleFromHit(hitPose, referenceSpace) {
        if (!this.reticle || !hitPose || !hitPose.transform) return;

        const transform = hitPose.transform;
        
        // Track if reticle was previously hidden (for UX state transition)
        const wasHidden = !this.reticle.visible;
        
        // Update reticle position (with local-floor, already in Y-up)
        this.reticle.visible = true;
        
        // Notify UX system that floor was detected (model-viewer style)
        if (wasHidden) {
            this.onFloorDetected();
        }
        this.reticle.position.set(
            transform.position.x,
            transform.position.y,
            transform.position.z
        );
        
        // Debug plane will be updated after splat is placed
        
        // Keep reticle flat on ground (don't use hit orientation)
        // The reticle is already rotated to lie flat in createARReticle()
        
        this.reticle.updateMatrix();
        
        // Store hit position for tap placement
        const hitPosition = new window.THREE.Vector3(
            transform.position.x,
            transform.position.y,
            transform.position.z
        );
        
        const hitQuaternion = new window.THREE.Quaternion(
            transform.orientation.x,
            transform.orientation.y,
            transform.orientation.z,
            transform.orientation.w
        );
        
        // Store hit position for tap placement or movement
        this.pendingHitPosition = hitPosition;
        
        if (!this.splatPlaced) {
            // First placement - store quaternion
            this.pendingHitQuaternion = hitQuaternion;
        } else {
            // Splat already placed - show move hint if in translate mode
            // Only update status occasionally to avoid spam
            if (Math.random() < 0.01) { // Update 1% of frames
                if (this.arTransformMode === 'translate') {
                    this.updateStatus('Tap to move splat here. Double-tap to switch mode.');
                } else {
                    this.updateStatus(`AR mode: ${this.arTransformMode === 'rotate' ? 'Rotate' : 'Scale'}. Double-tap to switch mode.`);
                }
            }
        }
    }

    setupARFrameLoop() {
        if (!this.renderer || !this.xrSession) return;

        // Override animation loop for AR mode
        // In XR mode, we need to render within the XR frame callback
        // Three.js handles the XR framebuffer, but we must call render() inside the callback
        this.renderer.setAnimationLoop((time, frame) => {
            if (!this.renderer.xr.isPresenting) {
                // Restore desktop loop if not in AR
                if (this.desktopAnimationLoop) {
                    this.renderer.setAnimationLoop(this.desktopAnimationLoop);
                }
                return;
            }

            // CRITICAL: Only render if we have a valid XR frame
            // The frame parameter is the XR frame - if it's null/undefined, we're not in an XR frame callback
            if (!frame) {
                return; // Don't render without a valid XR frame
            }

            // Begin stats measurement
            if (this.stats) {
                this.stats.begin();
            }
            
            // Store frame for processInput
            this.frame = frame;

            // Verify reference space on first frame (debug only)
            if (!this._refSpaceChecked) {
                this._refSpaceChecked = true;
                // Using same 'local' reference space for camera and hit-testing (model-viewer approach)
            }

            // Calculate delta time for smooth interpolation (model-viewer approach)
            const delta = frame ? (frame.predictedDisplayTime ? frame.predictedDisplayTime * 1000 : 16.67) : 16.67;
            
            // Track phone position vs floor for debugging
            this.trackFloorOffset(frame);
            
            // Before placement: show reticle at detected floor position
            if (!this.splatPlaced) {
                // Use initialHitSource to detect floor and show reticle
                if (this.initialHitSource) {
                    this.moveToFloor(frame);
                } else if (this.hitTestSource) {
                    // Fallback to main hit-test source
                    this.updateReticle(frame);
                } else {
                    // Fallback to raycasting
                    this.updateReticleWithRaycasting(frame);
                }
            }
            
            // After placement: update splat position and handle gestures
            if (this.splatPlaced && this.splatMesh) {
                // Update pivot position with smooth interpolation (model-viewer approach)
                this.updatePivotPosition(delta);
                
                // Handle gestures through XR input sources
                if (this.xrSession) {
                    this.processXRInput(frame);
                }
                
                // Update manipulation ring fade animation
                if (this.manipulationRing && this.manipulationRingFadeStartTime > 0) {
                    this.updateManipulationRingFade();
                }
                
                // Update debug plane if enabled
                if (this.showDebugFloor) {
                    this.updateDebugFloorPlaneAtSplat();
                }
                
                // Hide reticle after placement
                if (this.reticle) {
                    this.reticle.visible = false;
                }
            }

            // Render scene - this is safe to call inside the XR animation frame callback
            // We've verified frame exists, so we're definitely in an XR frame callback
            if (this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
            
            // End stats measurement
            if (this.stats) {
                this.stats.end();
            }
        });
        
        this.arFrameLoopActive = true;
    }

    updateReticle(frame) {
        if (!this.reticle) {
            return;
        }

        const referenceSpace = this.renderer.xr.getReferenceSpace();
        if (!referenceSpace) {
            this.reticle.visible = false;
            return;
        }

        // Try main hit test source first
        if (this.hitTestSource) {
            try {
                const hitTestResults = frame.getHitTestResults(this.hitTestSource);
                
                // Debug: log reticle Y position occasionally
                if (hitTestResults.length > 0 && !this._lastReticleLogTime || performance.now() - this._lastReticleLogTime > 2000) {
                    const hit = hitTestResults[0];
                    const pose = hit.getPose(referenceSpace);
                    if (pose) {
                        const pos = pose.transform.position;
                        console.log('🎯 [RETICLE] Y position:', pos.y.toFixed(3), 'm');
                        this._lastReticleLogTime = performance.now();
                    }
                }
                if (hitTestResults.length > 0) {
                    const hit = hitTestResults[0];
                    const hitPose = hit.getPose(referenceSpace);

                    if (hitPose && hitPose.transform) {
                        // Update reticle and store hit data
                        this.updateReticleFromHit(hitPose, referenceSpace);
                        return;
                    }
                }
            } catch (error) {
                // Silently handle errors (common when session ends)
            }
        }
        
        // Fallback to initial hit source (for automatic placement feedback)
        if (this.initialHitSource && !this.splatPlaced) {
            try {
                const hitTestResults = frame.getHitTestResults(this.initialHitSource);
                if (hitTestResults.length > 0) {
                    const hit = hitTestResults[0];
                    const hitPose = hit.getPose(referenceSpace);
                    if (hitPose && hitPose.transform) {
                        this.updateReticleFromHit(hitPose, referenceSpace);
                        return;
                    }
                }
            } catch (error) {
                // Silently handle errors (common when session ends)
            }
        }
        
        // Hide reticle if no hits
        this.reticle.visible = false;
    }

    updateReticleWithRaycasting(frame) {
        // Fallback reticle update using raycasting (works without hit-test)
        // First tries to use detected planes if available (ARCore), otherwise uses raycasting
        if (!this.reticle || !this.camera || !this.scene || !frame) {
            return;
        }

        // Try to use detected planes first (ARCore plane detection on Android)
        if (this.xrPlanes && this.xrPlanes.planes && this.xrPlanes.planes.size > 0) {
            const floorPlane = this.findFloorPlane(frame);
            if (floorPlane) {
                this.updateReticleFromPlane(frame, floorPlane);
                return;
            }
        }

        // Fall back to raycasting if no planes detected

        // Get the current AR camera position from the XR frame
        // In AR mode, Three.js updates the camera automatically, but we need the current pose
        const referenceSpace = this.renderer.xr.getReferenceSpace();
        if (!referenceSpace) {
            this.reticle.visible = false;
            return;
        }

        // Get viewer pose (camera position in AR space)
        const viewerPose = frame.getViewerPose(referenceSpace);
        if (!viewerPose) {
            this.reticle.visible = false;
            return;
        }

        // Extract camera position from viewer pose
        const cameraPosition = new window.THREE.Vector3();
        cameraPosition.setFromMatrixPosition(
            new window.THREE.Matrix4().fromArray(viewerPose.transform.matrix)
        );

        // Extract camera orientation from viewer pose
        const cameraQuaternion = new window.THREE.Quaternion();
        cameraQuaternion.setFromRotationMatrix(
            new window.THREE.Matrix4().fromArray(viewerPose.transform.matrix)
        );

        // Use screen center for raycasting (like model-viewer)
        const raycaster = new window.THREE.Raycaster();
        
        // Calculate ray direction: point downward at an angle from camera forward
        // This makes placement more intuitive (like pointing at the ground)
        const HIT_ANGLE_DEG = 20; // Angle downward from camera forward
        const hitAngleRad = HIT_ANGLE_DEG * Math.PI / 180;
        
        // Start with camera's forward direction in local space
        const cameraForward = new window.THREE.Vector3(0, 0, -1);
        const cameraDown = new window.THREE.Vector3(0, -1, 0);
        
        // Rotate forward direction to point downward at the hit angle
        // This creates a direction that's angled down from the camera's view
        const angledDirection = new window.THREE.Vector3()
            .addVectors(
                cameraForward.clone().multiplyScalar(Math.cos(hitAngleRad)),
                cameraDown.clone().multiplyScalar(Math.sin(hitAngleRad))
            )
            .normalize();
        
        // Apply camera's world rotation to the direction
        // This ensures the ray points in the correct direction relative to the AR world
        angledDirection.applyQuaternion(cameraQuaternion);
        
        // Calculate floor height dynamically based on camera position
        // In "local" reference space, the origin might not be at the floor
        // Always calculate floor relative to camera: assume camera is ~1.5m above floor
        let floorHeight;
        if (this.arFloorHeight !== undefined) {
            floorHeight = this.arFloorHeight;
        } else {
            // Estimate floor: always place it 1.5m below camera (typical eye height)
            const estimatedEyeHeight = 1.5; // meters
            floorHeight = cameraPosition.y - estimatedEyeHeight;
        }
        
        // Create ground plane at calculated floor height
        // Plane normal points up (0, 1, 0), offset by -floorHeight
        const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), -floorHeight);
        
        // Ensure the ray can hit the plane by checking direction
        // The ray should point toward the floor (downward if camera is above floor)
        // If camera is above floor, ensure ray Y is negative
        // If camera is below floor, ensure ray Y is positive
        const cameraAboveFloor = cameraPosition.y > floorHeight;
        
        if (cameraAboveFloor && angledDirection.y > 0) {
            // Camera is above floor but ray points up - flip Y
            angledDirection.y = -Math.abs(angledDirection.y);
        } else if (!cameraAboveFloor && angledDirection.y < 0) {
            // Camera is below floor but ray points down - flip Y
            angledDirection.y = Math.abs(angledDirection.y);
        }
        
        // Create ray from current AR camera position
        raycaster.ray.set(cameraPosition, angledDirection);
        
        const intersectionPoint = new window.THREE.Vector3();
        const hasIntersection = raycaster.ray.intersectPlane(groundPlane, intersectionPoint);
        
        // Debug: Log camera and intersection info (only occasionally to avoid spam)
        if (Math.random() < 0.01) { // 1% of frames
            console.log('🔍 [RETICLE DEBUG]', {
                cameraY: cameraPosition.y.toFixed(2),
                floorHeight: floorHeight.toFixed(2),
                rayDirY: angledDirection.y.toFixed(3),
                hasIntersection,
                intersectionY: hasIntersection ? intersectionPoint.y.toFixed(2) : 'N/A',
                distance: hasIntersection ? cameraPosition.distanceTo(intersectionPoint).toFixed(2) : 'N/A',
                rayOrigin: `(${cameraPosition.x.toFixed(2)}, ${cameraPosition.y.toFixed(2)}, ${cameraPosition.z.toFixed(2)})`,
                rayDir: `(${angledDirection.x.toFixed(3)}, ${angledDirection.y.toFixed(3)}, ${angledDirection.z.toFixed(3)})`
            });
        }
        
        if (hasIntersection) {
            // Use the actual intersection point from the ray/plane intersection
            // Don't force Y to floorHeight - the intersection calculation already gives us the correct point
            
            // Additional check: if intersection is too close to camera (likely wrong), hide reticle
            const distanceToCamera = cameraPosition.distanceTo(intersectionPoint);
            if (distanceToCamera < 0.1 || distanceToCamera > 10) {
                // Too close or too far - likely incorrect intersection
                this.reticle.visible = false;
                return;
            }
            
            // Check if ray is pointing toward the floor (should intersect below camera if camera is above floor)
            // If camera is above floor, intersection should be below camera
            const isAboveFloor = cameraPosition.y > floorHeight;
            const isBelowFloor = intersectionPoint.y < cameraPosition.y;
            
            if (isAboveFloor && !isBelowFloor) {
                // Camera is above floor but intersection is not below camera - likely wrong
                this.reticle.visible = false;
                return;
            }
            
            // Track if reticle was previously hidden (for UX state transition)
            const wasHidden = !this.reticle.visible;
            
            // Show reticle at the exact intersection point (don't modify it)
            this.reticle.visible = true;
            this.reticle.position.copy(intersectionPoint);
            
            // Notify UX system that floor was detected (model-viewer style)
            if (wasHidden) {
                this.onFloorDetected();
            }
            
            // Debug plane will be updated after splat is placed
            
            // Keep reticle flat on ground (already rotated in createARReticle())
            
            // Store hit position for tap placement - use the EXACT reticle position
            // This ensures the splat is placed exactly where the reticle shows
            // Match the old version behavior: pendingHitPosition = reticle position
            this.pendingHitPosition = this.reticle.position.clone();
            
            // Create a quaternion that aligns with ground (flat)
            // Match the old version: use the hit quaternion from the plane intersection
            const groundQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                new window.THREE.Vector3(1, 0, 0),
                Math.PI // 180° rotation around X-axis (coordinate system fix)
            );
            this.pendingHitQuaternion = groundQuaternion;
            
            // Calibrate floor height from actual intersection (for future calculations)
            // This helps improve accuracy for subsequent reticle updates
            if (this.arFloorHeight === undefined) {
                this.arFloorHeight = intersectionPoint.y;
                console.log('📏 [FLOOR CALIBRATION] Floor height from raycasting:', this.arFloorHeight.toFixed(2), 'm');
            }
            
            // Debug: Log reticle and pending position match (occasionally)
            if (Math.random() < 0.01) {
                console.log('📍 [RETICLE SYNC]', {
                    reticlePos: this.reticle.position.toArray().map(v => v.toFixed(3)),
                    pendingPos: this.pendingHitPosition.toArray().map(v => v.toFixed(3)),
                    match: this.reticle.position.distanceTo(this.pendingHitPosition) < 0.001
                });
            }
        } else {
            // Hide reticle if no intersection
            this.reticle.visible = false;
        }
    }

    findFloorPlane(frame) {
        // Find the best floor plane from detected planes (ARCore plane detection)
        // Floor planes are typically horizontal (normal pointing up) and at a reasonable height
        if (!this.xrPlanes || !this.xrPlanes.planes || this.xrPlanes.planes.size === 0) {
            return null;
        }

        const referenceSpace = this.renderer.xr.getReferenceSpace();
        if (!referenceSpace) return null;

        // Get viewer pose to determine camera height
        const viewerPose = frame.getViewerPose(referenceSpace);
        if (!viewerPose) return null;

        const cameraPosition = new window.THREE.Vector3();
        cameraPosition.setFromMatrixPosition(
            new window.THREE.Matrix4().fromArray(viewerPose.transform.matrix)
        );

        let bestPlane = null;
        let bestScore = -Infinity;

        // Iterate through detected planes to find the best floor plane
        for (const plane of this.xrPlanes.planes.values()) {
            // Get plane pose
            const planePose = frame.getPose(plane.planeSpace, referenceSpace);
            if (!planePose) continue;

            // Extract plane position
            const planeMatrix = new window.THREE.Matrix4().fromArray(planePose.transform.matrix);
            const planePosition = new window.THREE.Vector3();
            planePosition.setFromMatrixPosition(planeMatrix);
            
            // Get plane normal (typically the Y-axis of the plane space)
            const planeNormal = new window.THREE.Vector3(0, 1, 0);
            planeNormal.applyMatrix4(planeMatrix).sub(planePosition).normalize();

            // Score plane based on:
            // 1. Normal pointing up (Y component close to 1)
            // 2. Plane height below camera (reasonable floor height)
            // 3. Plane size (larger is better for floor)
            const normalUpScore = planeNormal.y; // Should be close to 1 for floor
            const heightScore = Math.max(0, 1 - Math.abs(planePosition.y - (cameraPosition.y - 1.5)) / 2); // Prefer planes ~1.5m below camera
            const sizeScore = plane.polygon ? Math.min(plane.polygon.length / 10, 1) : 0.5; // Larger planes are better

            const totalScore = normalUpScore * 0.5 + heightScore * 0.3 + sizeScore * 0.2;

            if (totalScore > bestScore && normalUpScore > 0.7) { // Only consider planes with normal pointing up
                bestScore = totalScore;
                bestPlane = { plane, planePose, planePosition, planeNormal };
            }
        }

        return bestPlane;
    }

    updateReticleFromPlane(frame, floorPlaneData) {
        // Update reticle position based on detected floor plane (ARCore)
        if (!this.reticle || !floorPlaneData) {
            return;
        }

        const { planePose, planePosition, planeNormal } = floorPlaneData;
        const referenceSpace = this.renderer.xr.getReferenceSpace();
        if (!referenceSpace) return;

        // Get camera position
        const viewerPose = frame.getViewerPose(referenceSpace);
        if (!viewerPose) return;

        const cameraPosition = new window.THREE.Vector3();
        cameraPosition.setFromMatrixPosition(
            new window.THREE.Matrix4().fromArray(viewerPose.transform.matrix)
        );

        // Project camera position onto the plane using raycasting
        const raycaster = new window.THREE.Raycaster();
        const cameraDirection = new window.THREE.Vector3(0, 0, -1);
        const cameraQuaternion = new window.THREE.Quaternion();
        cameraQuaternion.setFromRotationMatrix(
            new window.THREE.Matrix4().fromArray(viewerPose.transform.matrix)
        );
        cameraDirection.applyQuaternion(cameraQuaternion);

        // Create ray from camera pointing down at 20° angle
        const downVector = new window.THREE.Vector3(0, -1, 0);
        const HIT_ANGLE_DEG = 20;
        const hitAngleRad = HIT_ANGLE_DEG * Math.PI / 180;
        const angledDirection = new window.THREE.Vector3()
            .addVectors(
                cameraDirection.clone().multiplyScalar(Math.cos(hitAngleRad)),
                downVector.clone().multiplyScalar(Math.sin(hitAngleRad))
            )
            .normalize();

        raycaster.ray.set(cameraPosition, angledDirection);

        // Intersect with the detected plane
        const plane = new window.THREE.Plane(planeNormal, -planeNormal.dot(planePosition));
        const intersectionPoint = new window.THREE.Vector3();
        const hasIntersection = raycaster.ray.intersectPlane(plane, intersectionPoint);

        if (hasIntersection) {
            // Track if reticle was previously hidden (for UX state transition)
            const wasHidden = !this.reticle.visible;
            
            this.reticle.visible = true;
            this.reticle.position.copy(intersectionPoint);
            
            // Notify UX system that floor was detected (model-viewer style)
            if (wasHidden) {
                this.onFloorDetected();
            }
            
            // Debug plane will be updated after splat is placed
            
            // Keep reticle flat on ground (already rotated in createARReticle())

            // Store for tap placement
            this.pendingHitPosition = intersectionPoint.clone();
            const groundQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                new window.THREE.Vector3(1, 0, 0),
                Math.PI
            );
            this.pendingHitQuaternion = groundQuaternion;

            // Calibrate floor height from detected plane
            if (this.arFloorHeight === undefined) {
                this.arFloorHeight = intersectionPoint.y;
                console.log('📏 [FLOOR CALIBRATION] Floor height from ARCore plane detection:', this.arFloorHeight.toFixed(2), 'm');
            }
        } else {
            this.reticle.visible = false;
        }
    }

    setupARTapEvent() {
        if (!this.xrSession) {
            console.log('⚠️ [TAP SETUP] No XR session available');
            return;
        }
        
        console.log('✅ [TAP SETUP] Setting up tap event handlers');
        
        // Listen for select/click events to place or move the splat
        // Store reference to session for checking if it's still valid
        const session = this.xrSession;
        const self = this;
        
        session.addEventListener('select', (event) => {
            // Ignore events during AR exit, if session changed, or no longer active
            if (self._isExitingAR || self.xrSession !== session || !self.xrSession) {
                console.log('🟣 [SELECT EVENT] Ignored - AR exit in progress or session changed');
                return;
            }
            
            console.log('🟣 [SELECT EVENT] splatPlaced:', self.splatPlaced, 'pendingHit:', !!self.pendingHitPosition, 'hitTestSource:', !!self.hitTestSource);
            if (!self.splatPlaced) {
                if (self.pendingHitPosition && self.pendingHitQuaternion) {
                    // First placement with hit-test data
                    console.log('🟢 [PLACEMENT] Using hit-test position');
                    self.placeSplatOnGround(self.pendingHitPosition, self.pendingHitQuaternion);
                    self.pendingHitPosition = null;
                    self.pendingHitQuaternion = null;
                } else if (!self.hitTestSource) {
                    // Fallback: place at fixed distance when hit-test is not available
                    console.log('🟡 [PLACEMENT] Using fixed distance (no hit-test)');
                    self.placeSplatAtFixedDistance();
                } else {
                    console.log('⚠️ [PLACEMENT] No placement method available');
                }
            } else if (self.splatPlaced && self.pendingHitPosition && self.arTransformMode === 'translate') {
                // Move splat to new hit position
                console.log('🟢 [MOVE] Moving splat to new position');
                self.moveSplatToPosition(self.pendingHitPosition);
                self.pendingHitPosition = null;
            }
        });
        
        // Also listen for click events on the canvas (for desktop testing)
        // Note: This should only handle placement, not gestures
        // Gestures are handled by setupARGestureControls()
        if (this.renderer && this.renderer.domElement) {
            const canvas = this.renderer.domElement;
            const clickHandler = (event) => {
                console.log('🟣 [CLICK/TAP] Event:', event.type, 'splatPlaced:', this.splatPlaced, 'xrSession:', !!this.xrSession);
                // Only handle if it's a quick tap (not a drag/gesture)
                // Check if this was a quick tap by checking if no movement occurred
                if (!this.splatPlaced && this.xrSession) {
                    console.log('🟡 [TAP] Attempting placement - pendingHit:', !!this.pendingHitPosition, 'hitTestSource:', !!this.hitTestSource);
                    if (this.pendingHitPosition && this.pendingHitQuaternion) {
                        // First placement with hit-test - quick tap only
                        console.log('🟢 [PLACEMENT] Using hit-test position (click)');
                        this.placeSplatOnGround(this.pendingHitPosition, this.pendingHitQuaternion);
                        this.pendingHitPosition = null;
                        this.pendingHitQuaternion = null;
                    } else if (!this.hitTestSource) {
                        // Fallback: place at fixed distance when hit-test is not available
                        console.log('🟡 [PLACEMENT] Using fixed distance (click, no hit-test)');
                        this.placeSplatAtFixedDistance();
                    } else {
                        console.log('⚠️ [PLACEMENT] No placement method available (click)');
                    }
                } else if (this.splatPlaced && this.xrSession && this.pendingHitPosition && this.arTransformMode === 'translate') {
                    // Move splat to new hit position - only if it's a quick tap
                    // Don't interfere with drag gestures
                    const touchDuration = event.timeStamp - (this.lastTouchStartTime || 0);
                    if (touchDuration < 200) { // Quick tap only
                        console.log('🟢 [MOVE] Moving splat (click)');
                        this.moveSplatToPosition(this.pendingHitPosition);
                        this.pendingHitPosition = null;
                    }
                }
            };
            // Use click for desktop, but be careful with touch events
            // We'll use a timeout to distinguish taps from drags
            canvas.addEventListener('click', clickHandler);
            // Don't add touchend here - let gesture handler manage it
            // Only add touchend if we need it for placement, but make it non-capturing
            const touchEndHandler = (event) => {
                console.log('🟣 [TOUCH END] Event:', event.type, 'splatPlaced:', this.splatPlaced, 'xrSession:', !!this.xrSession);
                // Only handle if it's a very quick tap (placement only)
                if (!this.splatPlaced && this.xrSession) {
                    const touchDuration = event.timeStamp - (this.lastTouchStartTime || 0);
                    console.log('🟡 [TOUCH END] Duration:', touchDuration, 'ms (threshold: 150ms)');
                    if (touchDuration < 150) { // Very quick tap
                        console.log('🟢 [TOUCH END] Quick tap detected - attempting placement');
                        if (this.pendingHitPosition && this.pendingHitQuaternion) {
                            clickHandler(event);
                        } else if (!this.hitTestSource) {
                            // Fallback: place at fixed distance when hit-test is not available
                            console.log('🟡 [PLACEMENT] Using fixed distance (touchend, no hit-test)');
                            this.placeSplatAtFixedDistance();
                        } else {
                            console.log('⚠️ [PLACEMENT] No placement method available (touchend)');
                        }
                    } else {
                        console.log('⚠️ [TOUCH END] Not a quick tap, ignoring (duration too long)');
                    }
                }
            };
            canvas.addEventListener('touchend', touchEndHandler, { capture: false }); // Non-capturing
            
            // Store handler for cleanup
            this.arTapHandler = clickHandler;
        }
    }

    placeSplatAtFixedDistance() {
        // Fallback placement method when hit-test is not available
        // Places splat at a fixed distance in front of the camera
        console.log('🟡 [PLACE FIXED] Attempting fixed distance placement');
        if (!this.camera || !this.splatMesh || this.splatPlaced) {
            console.log('⚠️ [PLACE FIXED] Cannot place - camera:', !!this.camera, 'mesh:', !!this.splatMesh, 'alreadyPlaced:', this.splatPlaced);
            return;
        }
        console.log('✅ [PLACE FIXED] Conditions met, placing splat');
        
        // Fixed distance in front of camera (1.5 meters)
        const distance = 1.5;
        
        // Get camera forward direction
        const forward = new window.THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(this.camera.quaternion);
        
        // Calculate position in front of camera
        const position = new window.THREE.Vector3();
        position.copy(this.camera.position);
        position.add(forward.multiplyScalar(distance));
        
        // Place on ground - use calibrated floor height if available
        // In local reference space, floor is typically ~1.5m below session start
        // In local-floor reference space, floor is at Y=0
        if (this.arFloorHeight !== undefined) {
            position.y = this.arFloorHeight;
        } else if (this.goalPosition && this.goalPosition.y !== 0) {
            // Use previously placed floor level
            position.y = this.goalPosition.y;
        } else {
            // Estimate floor ~1.5m below camera (typical eye height)
            position.y = this.camera.position.y - 1.5;
        }
        
        console.log('📍 [FALLBACK PLACEMENT] Floor Y:', position.y.toFixed(3));
        
        // Use default quaternion (no rotation from hit-test)
        const quaternion = new window.THREE.Quaternion();
        quaternion.copy(this.camera.quaternion);
        
        // Place the splat
        this.placeSplatOnGround(position, quaternion);
    }

    placeSplatOnGround(hitPosition, hitQuaternion) {
        console.log('🟢 [PLACE ON GROUND] Attempting placement');
        console.log('   hitPosition Y:', hitPosition ? hitPosition.y.toFixed(3) : 'null');
        console.log('   reticle visible:', this.reticle ? this.reticle.visible : 'no reticle');
        console.log('   reticle Y:', this.reticle ? this.reticle.position.y.toFixed(3) : 'N/A');
        
        if (!this.splatMesh || this.splatPlaced) {
            console.log('⚠️ [PLACE ON GROUND] Cannot place - mesh:', !!this.splatMesh, 'alreadyPlaced:', this.splatPlaced);
            return;
        }
        
        // Use the exact reticle position if available (ensures splat is placed exactly where reticle shows)
        // This matches the old version behavior where pendingHitPosition came from reticle position
        const placementPosition = (this.reticle && this.reticle.visible) 
            ? this.reticle.position.clone() 
            : hitPosition.clone();
        
        console.log('   FINAL placement Y:', placementPosition.y.toFixed(3));
        
        console.log('📍 [PLACEMENT] Position source:', {
            fromReticle: this.reticle && this.reticle.visible,
            reticlePos: this.reticle ? this.reticle.position.toArray().map(v => v.toFixed(3)) : 'N/A',
            hitPos: hitPosition.toArray().map(v => v.toFixed(3)),
            finalPos: placementPosition.toArray().map(v => v.toFixed(3))
        });
        
        // Calibrate floor height on first placement (for raycasting fallback)
        if (this.arFloorHeight === undefined) {
            this.arFloorHeight = placementPosition.y;
            console.log('📏 [FLOOR CALIBRATION] Floor height set to:', this.arFloorHeight.toFixed(2), 'm');
        }
        console.log('✅ [PLACE ON GROUND] Conditions met, placing splat');

        const mesh = this.splatMesh;
        
        // Ensure mesh is visible and in the scene
        mesh.visible = true;
        if (!mesh.parent && this.scene) {
            this.scene.add(mesh);
        }
        
        // Force update to ensure visibility
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        
        // Use transformAr if available
        const transformAr = this.options.transformAr;
        
        // Apply transformAr scale FIRST (before computing bounding box, as scale affects it)
        if (transformAr && transformAr.scale) {
            mesh.scale.set(
                transformAr.scale.x || 1,
                transformAr.scale.y || 1,
                transformAr.scale.z || 1
            );
        }
        
        // Apply rotation from hit quaternion, then apply transformAr rotation (before computing bounding box)
        if (hitQuaternion) {
            mesh.quaternion.copy(hitQuaternion);
            
            // Apply transformAr rotation if provided
            if (transformAr && transformAr.rotate) {
                const rotationX = (transformAr.rotate.x || 0) * (Math.PI / 180);
                const rotationY = (transformAr.rotate.y || 0) * (Math.PI / 180);
                const rotationZ = (transformAr.rotate.z || 0) * (Math.PI / 180);
                
                const transformEuler = new window.THREE.Euler(rotationX, rotationY, rotationZ, 'XYZ');
                const transformQuaternion = new window.THREE.Quaternion().setFromEuler(transformEuler);
                mesh.quaternion.multiplyQuaternions(mesh.quaternion, transformQuaternion);
            }
            
            mesh.rotation.setFromQuaternion(mesh.quaternion);
        }
        
        // Pivot is at base of splat, so no offset calculation needed
        console.log('📦 [PLACEMENT] Splat placement (pivot at base):', {
            placementY: placementPosition.y.toFixed(3),
            scale: `${mesh.scale.x.toFixed(2)}, ${mesh.scale.y.toFixed(2)}, ${mesh.scale.z.toFixed(2)}`
        });
        
        // Set goalPosition directly (no offset needed since pivot is at base)
        this.goalPosition.set(
            placementPosition.x + (transformAr?.position?.x || 0),
            placementPosition.y + (transformAr?.position?.y || 0),
            placementPosition.z + (transformAr?.position?.z || 0)
        );
        
        // Reset placement animation state
        this.placementComplete = false;
        
        // Set initial position directly to goal (will be interpolated smoothly)
        mesh.position.copy(this.goalPosition);
        
        console.log('✅ [PLACEMENT] Splat positioned at:', {
            final: mesh.position.toArray().map(v => v.toFixed(3)),
            reticle: this.reticle ? this.reticle.position.toArray().map(v => v.toFixed(3)) : 'N/A',
            goalY: this.goalPosition.y.toFixed(3)
        });
        
        // Force matrix update
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        
        // Final verification: ensure Y position matches reticle (critical for floor placement)
        if (this.reticle && this.reticle.visible) {
            const expectedY = this.reticle.position.y + (transformAr?.position?.y || 0);
            if (Math.abs(mesh.position.y - expectedY) > 0.001) {
                console.warn('⚠️ [PLACEMENT] Y position mismatch detected, correcting...', {
                    expected: expectedY.toFixed(3),
                    actual: mesh.position.y.toFixed(3),
                    difference: (mesh.position.y - expectedY).toFixed(3)
                });
                mesh.position.y = expectedY;
                mesh.updateMatrix();
                mesh.updateMatrixWorld(true);
            }
        }
        
        // Hide reticle after placement
        if (this.reticle) {
            this.reticle.visible = false;
        }
        
        this.splatPlaced = true;
        
        // Cancel initial hit source (no longer needed after placement)
        if (this.initialHitSource) {
            this.initialHitSource.cancel();
            this.initialHitSource = null;
        }
        
        // Update debug plane (if enabled)
        this.updateDebugFloorPlaneAtSplat();
        
        // Update UX state (model-viewer style)
        this.onModelPlaced();
        
        // Setup AR transform controls after placement
        this.setupARTransformControls(mesh);
    }

    setupARTransformControls(mesh) {
        if (!this.renderer || !this.camera || !window.TransformControls) {
            return;
        }

        // Remove existing transform controls if any
        if (this.arTransformControls) {
            if (this.scene) {
                // TransformControls is not a scene object, just dispose it
                this.arTransformControls.dispose();
            }
            this.arTransformControls = null;
        }

        // Create TransformControls for AR mode (visual only - we handle interactions manually)
        // We'll create it without attaching to DOM to prevent event conflicts
        // Instead, we'll manually update it based on our gesture controls
        this.arTransformControls = new window.TransformControls(this.camera, this.renderer.domElement);
        this.arTransformControls.attach(mesh);
        this.arTransformControls.setMode('translate'); // Start with translate mode
        this.arTransformControls.setSpace('world'); // Use world space for AR
        this.arTransformControls.visible = false; // Hide the visual axes - we handle interactions via gestures
        
        // Ensure mesh remains visible when transform controls are attached
        mesh.visible = true;
        
        // Constrain translation to floor plane (Z-up coordinate system)
        // We'll handle this in the change event
        this.arTransformControls.addEventListener('change', () => {
            // Ensure the mesh stays on the ground plane
            // Use fixed offset of 0 - mesh origin is assumed to be at ground level
            const groundZ = 0; // Ground plane at Z=0
            mesh.position.z = groundZ;
            
            // Update mesh matrix
            mesh.updateMatrix();
            mesh.updateMatrixWorld(true);
        });

        // TransformControls is not a THREE.Object3D, so we don't add it to the scene
        // Instead, we add it to the controls array and update it manually
        // The controls will be updated in the AR frame loop
        
        // Setup gesture controls for mode switching
        // Gestures are handled in processXRInput() in the frame loop - no separate setup needed
    }


    setupTransientHitTest() {
        // Setup WebXR transient hit-test source for touch input (like model-viewer)
        if (!this.xrSession) return;
        
        // Request transient hit-test source for touchscreen input
        if (this.xrSession.requestHitTestSourceForTransientInput) {
            this.xrSession.requestHitTestSourceForTransientInput({profile: 'generic-touchscreen'})
                .then(hitTestSource => {
                    this.transientHitTestSource = hitTestSource;
                    console.log('Transient hit-test source created for touch input');
                })
                .catch(error => {
                    console.warn('Failed to create transient hit-test source:', error);
                });
        }
        
        // Setup selectstart and selectend handlers (like model-viewer)
        this.xrSession.addEventListener('selectstart', this.onSelectStart);
        this.xrSession.addEventListener('selectend', this.onSelectEnd);
    }
    
    onSelectStart = (event) => {
        // Only handle placement - gestures are handled in processXRInput()
        // This handler is mainly for compatibility, actual gesture handling happens in frame loop
        if (!this.splatPlaced) {
            // Placement is handled by setupARTapEvent() select listener
            return;
        }
        
        // Gestures are handled in processXRInput() in the frame loop
        // Just store the input source for reference
        this.inputSource = event.inputSource;
    }
    
    onSelectEnd = () => {
        // Reset gesture state - actual gesture handling is in processXRInput()
        this.isTranslating = false;
        this.isRotating = false;
        this.isTwoHandInteraction = false;
        this.inputSource = null;
        this.lastDragPosition = null;
        this.firstRatio = 0;
        this.lastAngle = undefined;
        // Reset XR input tracking
        this.xrInputSources = [];
        this.xrInputStartPositions = [];
        this._lastActiveCount = 0;
        this._lastInputSourcesCount = 0;
        // Reset gesture state
        this.lastAngle = undefined;
        this.initialSeparation = 0;
        this.initialScale = 1;
        this.isRotating = false;
        this.isTranslating = false;
        this.isTwoHandInteraction = false;
        console.log('Gesture ended');
    }
    
    
    processXRInput(frame) {
        // Process gestures through XR input sources (works without hit-test)
        if (!frame || !this.xrSession || !this.splatMesh) return;
        
        const inputSources = frame.session.inputSources;
        
        // Track when inputSources count changes (indicates finger down/up for screen inputs)
        if (inputSources.length !== this._lastInputSourcesCount) {
            console.log('🔵 [INPUT] inputSources count changed:', this._lastInputSourcesCount, '→', inputSources.length);
            this._lastInputSourcesCount = inputSources.length;
        }
        
        // If no inputs, check if we need to end gesture
        if (!inputSources || inputSources.length === 0) {
            if (this.xrInputStartPositions.length > 0) {
                console.log('🔵 [GESTURE] All fingers lifted (inputSources empty)');
                this.hideManipulationFeedback();
                this.xrInputStartPositions = [];
                this.xrInputSources = [];
                this.lastAngle = undefined;
                this.initialSeparation = 0;
                this.initialScale = 1;
                this.isRotating = false;
                this.isTranslating = false;
                this.isTwoHandInteraction = false;
            }
            return;
        }
        
        const mesh = this.splatMesh;
        const activeInputs = [];
        
        // Track active input sources
        // Debug: log raw input state once per second
        if (!this._lastInputDebugTime || performance.now() - this._lastInputDebugTime > 1000) {
            if (inputSources.length > 0) {
                console.log('🔍 [INPUT DEBUG] inputSources.length:', inputSources.length);
                for (let i = 0; i < inputSources.length; i++) {
                    const src = inputSources[i];
                    console.log('  [' + i + ']', {
                        targetRayMode: src.targetRayMode,
                        hasGamepad: !!src.gamepad,
                        axes: src.gamepad?.axes ? Array.from(src.gamepad.axes).map(v => v.toFixed(2)) : null,
                        buttons: src.gamepad?.buttons?.map((b, idx) => ({
                            idx,
                            pressed: b.pressed,
                            touched: b.touched,
                            value: b.value
                        }))
                    });
                }
                this._lastInputDebugTime = performance.now();
            }
        }
        
        for (let i = 0; i < inputSources.length; i++) {
            const inputSource = inputSources[i];
            if (inputSource && inputSource.gamepad && inputSource.gamepad.axes) {
                const axes = inputSource.gamepad.axes;
                // axes[0] = X (-1 to 1), axes[1] = Y (-1 to 1)
                // Y is inverted: -1 = top, 1 = bottom
                const screenX = axes[0];
                const screenY = axes[1];
                
                // For screen-based input (touch), check targetRayMode
                // 'screen' mode means finger touch - use presence in inputSources as active indicator
                const isScreenInput = inputSource.targetRayMode === 'screen';
                
                // Check button state as backup
                const buttons = inputSource.gamepad.buttons;
                const isButtonActive = buttons && buttons[0] && (buttons[0].pressed || buttons[0].touched || buttons[0].value > 0);
                
                // Screen inputs are active if they exist in inputSources
                // Other inputs need button press
                const isActive = isScreenInput || isButtonActive;
                
                if (isActive) {
                    activeInputs.push({
                        inputSource,
                        screenX,
                        screenY,
                        isActive
                    });
                }
            }
        }
        
        // Detect if number of inputs changed - need to re-initialize gesture
        const inputCountChanged = activeInputs.length !== this.xrInputStartPositions.length;
        
        // Initialize or re-initialize tracking when inputs change
        if (activeInputs.length > 0 && (this.xrInputStartPositions.length === 0 || inputCountChanged)) {
            this.xrInputStartPositions = activeInputs.map(input => ({
                screenX: input.screenX,
                screenY: input.screenY
            }));
            this.xrInputSources = activeInputs.map(input => input.inputSource);
            
            // Show manipulation feedback when gesture starts (model-viewer style)
            this.showManipulationFeedback();
            
            // Initialize gesture state based on number of inputs (like old version)
            if (activeInputs.length === 1) {
                // Single finger - determine if upper (rotation) or lower (translation) half
                const screenYPercent = ((activeInputs[0].screenY + 1) / 2) * 100;
                if (screenYPercent < 50) {
                    this.isRotating = true;
                    this.isTranslating = false;
                    // Initialize lastAngle using gamepad axes (same as rotation calculation)
                    // Set to undefined to skip first delta calculation
                    this.lastAngle = undefined;
                    this.rotationInitialized = false; // Flag to skip first rotation delta
                } else {
                    this.isTranslating = true;
                    this.isRotating = false;
                    // Initialize lastDragPosition - will be set from first hit in translation code
                    // Don't set it here to avoid position jump
                    this.lastDragPosition = null;
                }
            } else if (activeInputs.length === 2) {
                // Two fingers - initialize scale gesture
                this.isTwoHandInteraction = true;
                this.isTranslating = false;
                this.isRotating = false;
                
                // Calculate initial separation between fingers
                const current1 = activeInputs[0];
                const current2 = activeInputs[1];
                const deltaX = current2.screenX - current1.screenX;
                const deltaY = current2.screenY - current1.screenY;
                const separation = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                
                // CRITICAL: Capture current mesh scale at gesture START
                // This ensures scaling is relative to the splat's current size
                this.initialSeparation = separation;
                this.initialScale = mesh.scale.x; // Capture current scale (assuming uniform)
                
                console.log('🔷 [SCALE] New pinch gesture started:', {
                    initialSeparation: separation.toFixed(3),
                    initialScale: this.initialScale.toFixed(3)
                });
            }
            return; // Wait for next frame to detect movement
        }
        
        // Process gestures if we have tracked inputs
        if (activeInputs.length > 0 && this.xrInputStartPositions.length > 0) {
            if (activeInputs.length === 1 && this.xrInputStartPositions.length === 1) {
                // Single finger gesture
                const start = this.xrInputStartPositions[0];
                const current = activeInputs[0];
                const deltaX = current.screenX - start.screenX;
                const deltaY = current.screenY - start.screenY;
                const moveDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                
                // Only process if moved significantly
                if (moveDistance > 0.05) {
                    const startScreenYPercent = ((start.screenY + 1) / 2) * 100; // Convert -1..1 to 0..100%
                    const isUpperHalf = startScreenYPercent < 50;
                    const isLowerHalf = startScreenYPercent >= 50;
                    
                    if (isLowerHalf && this.isTranslating) {
                        // Translation along floor plane (like old version)
                        // Use hit-test to get actual 3D position, then calculate delta
                        // This prevents position reset issues
                        // Use Three.js's reference space to match camera coordinate system
                        const referenceSpace = this.renderer.xr.getReferenceSpace();
                        if (referenceSpace && this.transientHitTestSource) {
                            try {
                                const hitTestResults = frame.getHitTestResultsForTransientInput(this.transientHitTestSource);
                                if (hitTestResults && hitTestResults.length > 0) {
                                    const hit = hitTestResults[0];
                                    if (hit.results && hit.results.length > 0) {
                                        const hitPose = hit.results[0].getPose(referenceSpace);
                                        if (hitPose) {
                                            const hitMatrix = new window.THREE.Matrix4().fromArray(hitPose.transform.matrix);
                                            const hitPosition = new window.THREE.Vector3().setFromMatrixPosition(hitMatrix);
                                            
                                            // Use the splat's current Y position as the floor
                                            // This is where the splat was placed, so translations stay at that level
                                            const floorY = mesh.position.y;
                                            const hitOnGround = new window.THREE.Vector3(hitPosition.x, floorY, hitPosition.z);
                                            
                                            // Use lastDragPosition to calculate delta
                                            if (this.lastDragPosition) {
                                                const delta = new window.THREE.Vector3().subVectors(hitOnGround, this.lastDragPosition);
                                                
                                                // Clamp delta to avoid jumps
                                                const maxStep = 0.3; // meters per frame
                                                if (delta.length() > maxStep) {
                                                    delta.setLength(maxStep);
                                                }
                                                
                                                // Update position: only move X and Z, keep Y at placed floor level
                                                mesh.position.x += delta.x;
                                                mesh.position.z += delta.z;
                                                // Don't change Y - splat stays at placed floor level
                                                
                                                mesh.updateMatrix();
                                                mesh.updateMatrixWorld(true);
                                                
                                                // Update goalPosition to match (for debug plane tracking)
                                                this.goalPosition.x = mesh.position.x;
                                                this.goalPosition.z = mesh.position.z;
                                                
                                                // Update lastDragPosition with current hit projected to floor
                                                this.lastDragPosition = hitOnGround.clone();
                                                
                                                // Moved by delta (debug: delta.length() > 0.001)
                                            } else {
                                                // First frame - initialize lastDragPosition from hit (prevents jump)
                                                this.lastDragPosition = hitOnGround.clone();
                                            }
                                        }
                                    }
                                }
                            } catch (error) {
                                // Fallback to screen-based movement if hit-test fails
                            }
                        }
                        
                        // Update start position for continuous movement
                        this.xrInputStartPositions[0] = {
                            screenX: current.screenX,
                            screenY: current.screenY
                        };
                    } else if (isUpperHalf && this.isRotating) {
                        // Rotation around Y-axis (like old version - uses angle from axes)
                        if (current.inputSource.gamepad && current.inputSource.gamepad.axes) {
                            const axes = current.inputSource.gamepad.axes;
                            const angle = Math.atan2(axes[1], axes[0]);
                            
                            // Skip first frame to initialize lastAngle properly
                            if (this.lastAngle === undefined) {
                                this.lastAngle = angle;
                            } else {
                                // Calculate deltaYaw: angle - lastAngle (like old version)
                                let deltaYaw = angle - this.lastAngle;
                                
                                // Normalize to -PI..PI
                                if (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
                                else if (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;
                                
                                // Ignore large jumps (> 45 degrees) as they're likely noise
                                if (Math.abs(deltaYaw) > 0.01 && Math.abs(deltaYaw) < Math.PI / 4) {
                                    // Rotate around Y-axis (up axis) - WebXR uses Y-up coordinate system
                                    const rotationQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                                        new window.THREE.Vector3(0, 1, 0),
                                        deltaYaw
                                    );
                                    mesh.quaternion.multiplyQuaternions(rotationQuaternion, mesh.quaternion);
                                    mesh.rotation.setFromQuaternion(mesh.quaternion);
                                    
                                    mesh.updateMatrix();
                                    mesh.updateMatrixWorld(true);
                                }
                                
                                // Update angle for next frame
                                this.lastAngle = angle;
                            }
                            
                            // Update start position for continuous rotation
                            this.xrInputStartPositions[0] = {
                                screenX: current.screenX,
                                screenY: current.screenY
                            };
                        }
                    }
                }
            } else if (activeInputs.length === 2 && this.isTwoHandInteraction) {
                // Two finger gesture - pinch/scale
                const current1 = activeInputs[0];
                const current2 = activeInputs[1];
                
                const deltaX = current2.screenX - current1.screenX;
                const deltaY = current2.screenY - current1.screenY;
                const separation = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                
                // Use relative scaling: newScale = initialScale * (currentSeparation / initialSeparation)
                // initialScale is the scale when THIS pinch gesture started
                // initialSeparation is the finger separation when THIS pinch gesture started
                if (this.initialSeparation > 0 && this.initialScale > 0) {
                    const scaleRatio = separation / this.initialSeparation;
                    const newScale = this.initialScale * scaleRatio;
                    const minScale = this.options.minScale || 0.1;
                    const maxScale = this.options.maxScale || 5.0;
                    const clampedScale = Math.max(minScale, Math.min(maxScale, newScale));
                    
                    mesh.scale.set(clampedScale, clampedScale, clampedScale);
                                        
                    mesh.updateMatrix();
                    mesh.updateMatrixWorld(true);
                    
                    // NOTE: We do NOT update initialSeparation or initialScale here
                    // They stay fixed for the duration of this gesture
                    // This ensures the scale ratio is always relative to the gesture start
                }
            }
            
            // Update manipulation feedback ring during gesture (model-viewer style)
            this.updateManipulationFeedback();
        }
        
        // Reset tracking if no active inputs (gesture ended)
        // Only log when state changes to avoid spam
        if (activeInputs.length !== this._lastActiveCount) {
            console.log('🔵 [INPUT] Active inputs changed:', this._lastActiveCount, '→', activeInputs.length);
            this._lastActiveCount = activeInputs.length;
        }
        
        if (activeInputs.length === 0 && this.xrInputStartPositions.length > 0) {
            console.log('🔵 [GESTURE] Inputs released (was tracking', this.xrInputStartPositions.length, 'inputs)');
            
            // Hide manipulation feedback with fade out (model-viewer style)
            this.hideManipulationFeedback();
            
            // Clear tracking arrays
            this.xrInputStartPositions = [];
            this.xrInputSources = [];
            
            // Reset gesture mode flags
            this.isTranslating = false;
            this.isRotating = false;
            this.isTwoHandInteraction = false;
            this.lastAngle = undefined;
            this.lastDragPosition = null;
            
            // NOTE: We do NOT reset initialScale here!
            // initialScale will be re-captured from mesh.scale.x when the NEXT pinch starts
            // This ensures continuity between pinch gestures
        }
    }
    
    processInput(frame) {
        // Process touch input using transient hit-test (like model-viewer)
        if (!this.transientHitTestSource || !this.splatPlaced || !this.splatMesh) return;
        
        const fingers = frame.getHitTestResultsForTransientInput(this.transientHitTestSource);
        if (!fingers || fingers.length === 0) return;
        
        const mesh = this.splatMesh;
        
        // Handle two-finger gestures (scale only)
        if (fingers.length === 2 && this.isTwoHandInteraction) {
            const finger1 = fingers[0];
            const finger2 = fingers[1];
            
            if (finger1.inputSource.gamepad && finger2.inputSource.gamepad) {
                const axes1 = finger1.inputSource.gamepad.axes;
                const axes2 = finger2.inputSource.gamepad.axes;
                const deltaX = axes2[0] - axes1[0];
                const deltaY = axes2[1] - axes1[1];
                const separation = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                
                if (this.firstRatio > 0) {
                    // Scale based on separation
                    const scale = separation / this.firstRatio;
                    const minScale = this.options.minScale || 0.1;
                    const maxScale = this.options.maxScale || 5.0;
                    const clampedScale = Math.max(minScale, Math.min(maxScale, scale));
                    mesh.scale.set(clampedScale, clampedScale, clampedScale);
                    console.log('Scale:', clampedScale.toFixed(2));
                    
                    // Update ratio for continuous scaling
                    this.firstRatio = separation / mesh.scale.x;
                } else {
                    // First frame - initialize for scale
                    this.firstRatio = separation / mesh.scale.x;
                }
            }
            return;
        }
        
        // Handle one-finger rotate (body) when isRotating and single finger
        if (fingers.length === 1 && this.isRotating) {
            const finger = fingers[0];
            if (finger.inputSource.gamepad) {
                const axes = finger.inputSource.gamepad.axes;
                const angle = Math.atan2(axes[1], axes[0]);
                
                if (this.lastAngle !== undefined) {
                    // Calculate deltaYaw: angle - lastAngle (like model-viewer line 1007)
                    // This ensures rotation direction matches finger movement
                    let deltaYaw = angle - this.lastAngle;
                    if (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
                    else if (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;
                    
                    if (Math.abs(deltaYaw) > 0.01) { // Only rotate if significant change
                        // Rotate around Y-axis (up axis) - WebXR uses Y-up coordinate system
                        const rotationQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                            new window.THREE.Vector3(0, 1, 0),
                            deltaYaw
                        );
                        mesh.quaternion.multiplyQuaternions(rotationQuaternion, mesh.quaternion);
                        mesh.rotation.setFromQuaternion(mesh.quaternion);
                        console.log('Rotate:', (deltaYaw * 180 / Math.PI).toFixed(2) + '°');
                    }
                }
                
                // Update angle for next frame
                this.lastAngle = angle;
            }
            return;
        }
        
        // Handle single-finger translation
        if (fingers.length === 1) {
            const finger = fingers[0];
            let hit = null;
            
            // Get hit point from transient input
            if (finger.results.length > 0) {
                const referenceSpace = this.renderer.xr.getReferenceSpace();
                if (!referenceSpace) return;
                
                const pose = finger.results[0].getPose(referenceSpace);
                if (pose) {
                    const matrix = new window.THREE.Matrix4().fromArray(pose.transform.matrix);
                    hit = new window.THREE.Vector3().setFromMatrixPosition(matrix);
                }
            }
            
            // If not already translating or rotating, determine if touch is on upper or lower half of screen
            // Lower half of screen = translation, Upper half of screen = rotation
            if (!this.isTranslating && !this.isRotating) {
                let isLowerHalf = false;
                let isUpperHalf = false;
                let screenX = null;
                let screenY = null;
                let screenXPercent = null;
                let screenYPercent = null;
                
                // Use screen Y coordinate from gamepad axes: axes[1] is normalized screen Y (-1 to 1)
                // In normalized coordinates: negative Y = upper half, positive Y = lower half
                if (finger.inputSource.gamepad && finger.inputSource.gamepad.axes) {
                    const axes = finger.inputSource.gamepad.axes;
                    screenX = axes[0]; // Normalized screen X coordinate (-1 to 1)
                    screenY = axes[1]; // Normalized screen Y coordinate (-1 to 1)
                    
                    // Convert normalized coordinates to percentage (0-100%)
                    screenXPercent = ((screenX + 1) / 2) * 100;
                    screenYPercent = ((screenY + 1) / 2) * 100;
                    
                    // Upper half of screen (negative Y) = rotation
                    // Lower half of screen (positive Y) = translation
                    if (screenY < 0) {
                        isUpperHalf = true; // Upper half = rotation
                    } else {
                        isLowerHalf = true; // Lower half = translation
                    }
                } else if (hit) {
                    // Fallback: if no gamepad axes, use hit point Y coordinate
                    const hitOnGround = new window.THREE.Vector3(hit.x, 0, hit.z);
                    const splatCenter = new window.THREE.Vector3(mesh.position.x, 0, mesh.position.z);
                    const horizontalDistance = hitOnGround.distanceTo(splatCenter);
                    const SPLAT_RADIUS = 1.5;
                    
                    if (horizontalDistance <= SPLAT_RADIUS) {
                        const HALF_HEIGHT_THRESHOLD = 1.0;
                        if (hit.y <= HALF_HEIGHT_THRESHOLD) {
                            isLowerHalf = true;
                        } else {
                            isUpperHalf = true;
                        }
                    }
                }
                
                if (isLowerHalf) {
                    // Translate - touch is on lower half of screen
                    this.isTranslating = true;
                    this.isRotating = false;
                    // With local-floor, hit position is already on the floor
                    this.lastDragPosition = hit ? hit.clone() : mesh.position.clone();
                    console.log('🟢 [AR DEBUG] Auto-start Translation mode', {
                        screenCoords: screenX !== null ? `(${screenX.toFixed(3)}, ${screenY.toFixed(3)})` : 'N/A',
                        screenPercent: screenXPercent !== null ? `(${screenXPercent.toFixed(1)}%, ${screenYPercent.toFixed(1)}%)` : 'N/A',
                        region: 'Lower half of screen',
                        hitPoint: hit ? `(${hit.x.toFixed(2)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(2)})` : 'N/A'
                    });
                } else if (isUpperHalf) {
                    // Rotate - touch is on upper half of screen
                    this.isRotating = true;
                    this.isTranslating = false;
                    if (finger.inputSource.gamepad) {
                        const axes = finger.inputSource.gamepad.axes;
                        this.lastAngle = Math.atan2(axes[1], axes[0]);
                    } else {
                        this.lastAngle = 0;
                    }
                    console.log('🟡 [AR DEBUG] Auto-start Rotation mode', {
                        screenCoords: screenX !== null ? `(${screenX.toFixed(3)}, ${screenY.toFixed(3)})` : 'N/A',
                        screenPercent: screenXPercent !== null ? `(${screenXPercent.toFixed(1)}%, ${screenYPercent.toFixed(1)}%)` : 'N/A',
                        region: 'Upper half of screen',
                        hitPoint: hit ? `(${hit.x.toFixed(2)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(2)})` : 'N/A'
                    });
                }
            }
            
            if (hit && this.lastDragPosition && this.isTranslating) {
                // With local-floor reference space, hit positions are already floor-relative
                // No need to manually project to Y=0 - the hit position is already on the floor
                
                // Calculate movement delta
                const delta = new window.THREE.Vector3().subVectors(hit, this.lastDragPosition);
                
                // Clamp delta to avoid jumps
                const maxStep = 0.3; // meters per frame
                if (delta.length() > maxStep) {
                    delta.setLength(maxStep);
                }
                
                // Update position (local-floor ensures Y is already at floor level)
                mesh.position.add(delta);
                mesh.updateMatrix();
                mesh.updateMatrixWorld(true);
                
                // Update debug plane to follow splat
                this.updateDebugFloorPlaneAtSplat();
                
                // Update transform controls
                if (this.arTransformControls) {
                    this.arTransformControls.updateMatrixWorld();
                }
                
                // Update lastDragPosition
                this.lastDragPosition = hit.clone();
            }
        }
    }

    setupARGestureControls() {
        if (!this.renderer || !this.renderer.domElement) return;
        
        const canvas = this.renderer.domElement;
        
        // Remove existing gesture handlers
        if (this.arGestureHandler) {
            canvas.removeEventListener('touchstart', this.arGestureHandler);
            canvas.removeEventListener('touchmove', this.arGestureHandler);
            canvas.removeEventListener('touchend', this.arGestureHandler);
            canvas.removeEventListener('pointerdown', this.arGestureHandler);
            canvas.removeEventListener('pointermove', this.arGestureHandler);
            canvas.removeEventListener('pointerup', this.arGestureHandler);
        }
        
        if (!this.splatMesh) return;
        const mesh = this.splatMesh;
        
        // State for gesture tracking
        let touchStartPositions = [];
        let touchStartWorldPosition = null; // Store initial world-space intersection point for translation
        let touchStartDistance = 0;
        let touchStartScale = 1;
        let touchStartRotation = 0;
        let touchStartCenter = null;
        let isDragging = false;
        let lastTouchTime = 0;
        let touchCount = 0;
        
        // Helper to get touch/pointer position
        const getPosition = (event) => {
            if (event.touches && event.touches.length > 0) {
                return { x: event.touches[0].clientX, y: event.touches[0].clientY };
            } else if (event.clientX !== undefined) {
                return { x: event.clientX, y: event.clientY };
            }
            return null;
        };
        
        // Helper to get all touch positions
        const getAllPositions = (event) => {
            const positions = [];
            if (event.touches) {
                for (let i = 0; i < event.touches.length; i++) {
                    positions.push({ x: event.touches[i].clientX, y: event.touches[i].clientY });
                }
            } else if (event.clientX !== undefined) {
                positions.push({ x: event.clientX, y: event.clientY });
            }
            return positions;
        };
        
        // Helper to calculate distance between two points
        const getDistance = (p1, p2) => {
            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            return Math.sqrt(dx * dx + dy * dy);
        };
        
        // Helper to calculate angle between two points
        const getAngle = (p1, p2) => {
            return Math.atan2(p2.y - p1.y, p2.x - p1.x);
        };
        
        // Helper to get center point between two touches
        const getCenter = (p1, p2) => {
            return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        };
        
        // Helper to project screen point to ground plane using hit-test
        const projectToGround = async (screenX, screenY) => {
            if (!this.xrSession || !this.hitTestSource) return null;
            
            // For now, use a simple projection - in real AR, we'd use hit-test
            // This is a simplified version that projects forward from camera
            const camera = this.camera;
            if (!camera) return null;
            
            // Create a raycaster from camera through screen point
            const raycaster = new window.THREE.Raycaster();
            const mouse = new window.THREE.Vector2();
            
            // Convert screen coordinates to normalized device coordinates
            const rect = canvas.getBoundingClientRect();
            mouse.x = ((screenX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((screenY - rect.top) / rect.height) * 2 + 1;
            
            raycaster.setFromCamera(mouse, camera);
            
            // Intersect with ground plane (Y=0 in Y-up coordinate system)
            const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), 0);
            const intersectionPoint = new window.THREE.Vector3();
            raycaster.ray.intersectPlane(groundPlane, intersectionPoint);
            
            return intersectionPoint;
        };
        
        this.arGestureHandler = async (event) => {
            // Always log that handler was called (for debugging)
            if (event.type === 'touchstart' || event.type === 'pointerdown' || 
                event.type === 'touchmove' || event.type === 'pointermove') {
                console.log(`🔷 [GESTURE HANDLER CALLED] ${event.type} | splatPlaced: ${this.splatPlaced} | mesh: ${!!mesh}`);
            }
            
            if (!mesh) {
                console.log('⚠️ [GESTURE SKIPPED] Mesh missing');
                return;
            }
            
            // Handle placement when splat is not placed yet
            if (!this.splatPlaced) {
                if (event.type === 'touchstart' || event.type === 'pointerdown') {
                    const positions = getAllPositions(event);
                    if (positions.length === 1) {
                        // Single touch - place splat at reticle location (projected to ground)
                        const pos = positions[0];
                        const rect = canvas.getBoundingClientRect();
                        const ndc = new window.THREE.Vector2(
                            ((pos.x - rect.left) / rect.width) * 2 - 1,
                            -((pos.y - rect.top) / rect.height) * 2 + 1
                        );
                        
                        const raycaster = new window.THREE.Raycaster();
                        raycaster.setFromCamera(ndc, this.camera);
                        const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), 0);
                        const hitPosition = new window.THREE.Vector3();
                        raycaster.ray.intersectPlane(groundPlane, hitPosition);
                        
                        // Place splat at hit position
                        const hitQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                            new window.THREE.Vector3(1, 0, 0),
                            Math.PI // 180° rotation around X-axis (coordinate system fix)
                        );
                        
                        console.log('🟢 [PLACEMENT] Placing splat at:', hitPosition);
                        this.placeSplatOnGround(hitPosition, hitQuaternion);
                        event.preventDefault();
                        event.stopPropagation();
                    }
                }
                return; // Don't process gestures until splat is placed
            }
            
            const positions = getAllPositions(event);
            const numTouches = positions.length;
            
            // Enhanced debug logging for gesture detection
            if (event.type === 'touchstart' || event.type === 'pointerdown') {
                console.log('🟦 [GESTURE START]', event.type, '| Touches:', numTouches, '| Positions:', positions);
            } else if (event.type === 'touchmove' || event.type === 'pointermove') {
                // Log every move event with gesture type info
                const gestureType = numTouches === 2 ? 'PINCH/ROTATE' : (isDragging ? 'DRAG' : 'MOVING');
                console.log(`🟨 [GESTURE MOVE] ${gestureType} | Touches: ${numTouches} | isDragging: ${isDragging} | touchStartPositions: ${touchStartPositions.length}`);
            } else if (event.type === 'touchend' || event.type === 'pointerup') {
                console.log('🟩 [GESTURE END]', event.type, '| Touches:', numTouches);
            }
            
            // Always prevent default for gestures when splat is placed
            // This ensures gestures work properly
            if (event.type === 'touchmove' || event.type === 'pointermove' || 
                (event.type === 'touchstart' || event.type === 'pointerdown') && numTouches === 2) {
                event.preventDefault();
                event.stopPropagation();
            }
            
            // For pointer events in WebXR, we might need to handle them differently
            // If it's a pointer event and we don't have touchStartPositions, try to initialize
            if ((event.type === 'pointermove' || event.type === 'pointerdown') && 
                touchStartPositions.length === 0 && numTouches > 0) {
                // Initialize from current position if we missed the down event
                touchStartPositions = positions.map(p => ({ ...p }));
                touchCount = numTouches;
                this.lastTouchStartTime = event.timeStamp;
                console.log('Initialized from pointer event:', event.type);
                if (event.type === 'pointermove') {
                    // Wait for next move to detect actual movement
                    return;
                }
            }
            
            if (event.type === 'touchstart' || event.type === 'pointerdown') {
                console.log('Touch/pointer down detected:', event.type, 'positions:', positions.length, 'coords:', positions);
                touchCount = numTouches;
                touchStartPositions = positions.map(p => ({ ...p }));
                this.lastTouchStartTime = event.timeStamp;
                isDragging = false; // Reset dragging state
                touchStartWorldPosition = null; // Reset world position
                
                // Always prevent default for touch/pointer down in AR mode
                event.preventDefault();
                event.stopPropagation();
                
                if (numTouches === 1) {
                    // Single touch - check for double tap
                    const currentTime = Date.now();
                    if (currentTime - lastTouchTime < 300) {
                        // Double tap: cycle through modes
                        console.log('🔄 [DOUBLE-TAP] Cycling transform mode');
                        this.cycleARTransformMode();
                        isDragging = false;
                        return;
                    }
                    lastTouchTime = currentTime;
                    
                    // Determine screen region (upper vs lower half)
                    const rect = canvas.getBoundingClientRect();
                    const screenYPercent = ((positions[0].y - rect.top) / rect.height) * 100;
                    const isUpperHalf = screenYPercent < 50;
                    const isLowerHalf = screenYPercent >= 50;
                    
                    console.log(`🟦 [SINGLE-TOUCH START] Screen Y: ${screenYPercent.toFixed(1)}% | Upper: ${isUpperHalf} | Lower: ${isLowerHalf} | Mode: ${this.arTransformMode}`);
                    
                    // Calculate initial world-space intersection point for translation
                    // This will be used as the reference point for the drag
                    const camera = this.camera;
                    if (camera) {
                        const startNDC = new window.THREE.Vector2(
                            ((positions[0].x - rect.left) / rect.width) * 2 - 1,
                            -((positions[0].y - rect.top) / rect.height) * 2 + 1
                        );
                        const raycaster = new window.THREE.Raycaster();
                        raycaster.setFromCamera(startNDC, camera);
                        // Use Y-up coordinate system (Y=0 is ground plane)
                        const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), 0);
                        touchStartWorldPosition = new window.THREE.Vector3();
                        raycaster.ray.intersectPlane(groundPlane, touchStartWorldPosition);
                        
                        // Calculate offset from initial touch point to mesh center
                        // This offset will be maintained during the drag
                        const meshCenterOnGround = new window.THREE.Vector3(
                            mesh.position.x,
                            mesh.position.y,
                            mesh.position.z
                        );
                        this.dragOffset = new window.THREE.Vector3().subVectors(meshCenterOnGround, touchStartWorldPosition);
                        console.log(`🟦 [TOUCH START] WorldPos: (${touchStartWorldPosition.x.toFixed(2)}, ${touchStartWorldPosition.y.toFixed(2)}, ${touchStartWorldPosition.z.toFixed(2)}) | Offset: (${this.dragOffset.x.toFixed(2)}, ${this.dragOffset.y.toFixed(2)}, ${this.dragOffset.z.toFixed(2)})`);
                    }
                    // Don't set isDragging yet - wait for movement to distinguish tap from drag
                } else if (numTouches === 2) {
                    // Two touches - start gesture immediately
                    isDragging = true;
                    // Two touches - prepare for scale or rotate
                    touchStartDistance = getDistance(positions[0], positions[1]);
                    touchStartScale = mesh.scale.x;
                    touchStartCenter = getCenter(positions[0], positions[1]);
                    touchStartRotation = getAngle(positions[0], positions[1]);
                    console.log(`🔵 [TWO-FINGER START] Distance: ${touchStartDistance.toFixed(1)}px | Scale: ${touchStartScale.toFixed(2)} | Angle: ${(touchStartRotation * 180 / Math.PI).toFixed(1)}°`);
                }
            } else if (event.type === 'touchmove' || event.type === 'pointermove') {
                // Always prevent default for move events in AR mode to ensure gestures work
                event.preventDefault();
                event.stopPropagation();
                
                // Start dragging if we detect movement (for single touch)
                if (!isDragging && numTouches === 1) {
                    if (touchStartPositions.length === 0) {
                        // If we missed pointerdown/touchstart, initialize from current position
                        // This can happen in WebXR where pointer events might not fire correctly
                        touchStartPositions = positions.map(p => ({ ...p }));
                        touchCount = 1;
                        console.log('Initialized touchStartPositions from move event (missed down event), pos:', positions[0]);
                        return; // Wait for next move event to detect actual movement
                    }
                    
                    const startPos = touchStartPositions[0];
                    const currentPos = positions[0];
                    if (!startPos || !currentPos) {
                        console.log('Missing start or current position');
                        return;
                    }
                    
                    const moveDistance = Math.sqrt(
                        Math.pow(currentPos.x - startPos.x, 2) + 
                        Math.pow(currentPos.y - startPos.y, 2)
                    );
                    // Only start dragging if moved more than 5 pixels
                    if (moveDistance > 5) {
                        isDragging = true;
                        console.log('Started one-finger drag, distance:', moveDistance.toFixed(2), 'start:', startPos, 'current:', currentPos);
                    } else {
                        // Still too small, don't process yet
                        return;
                    }
                } else if (!isDragging && numTouches === 2) {
                    // Two-finger gesture - initialize if needed
                    if (touchStartPositions.length === 0) {
                        touchStartPositions = positions.map(p => ({ ...p }));
                        touchCount = 2;
                        touchStartDistance = getDistance(positions[0], positions[1]);
                        touchStartScale = mesh.scale.x;
                        touchStartCenter = getCenter(positions[0], positions[1]);
                        touchStartRotation = getAngle(positions[0], positions[1]);
                        console.log('Initialized two-finger gesture from move event');
                        return; // Wait for next move to process
                    }
                    isDragging = true;
                }
                
                if (!isDragging) {
                    console.log('Not dragging yet - touches:', numTouches, 'touchCount:', touchCount, 'touchStartPositions:', touchStartPositions.length);
                    return;
                }
                
                console.log('Processing gesture - touches:', numTouches, 'touchCount:', touchCount);
                
                if (numTouches === 1 && touchCount === 1) {
                    // One finger drag - determine if rotation (upper half) or translation (lower half)
                    const currentPos = positions[0];
                    const rect = canvas.getBoundingClientRect();
                    
                    // Use the start position to determine gesture type (not current position)
                    const startPos = touchStartPositions[0];
                    const startScreenYPercent = startPos ? ((startPos.y - rect.top) / rect.height) * 100 : 50;
                    const startIsUpperHalf = startScreenYPercent < 50;
                    const startIsLowerHalf = startScreenYPercent >= 50;
                    
                    console.log(`🟢 [SINGLE-FINGER DRAG] Start Y: ${startScreenYPercent.toFixed(1)}% | Upper: ${startIsUpperHalf} | Lower: ${startIsLowerHalf}`);
                    
                    const camera = this.camera;
                    
                    if (startIsLowerHalf) {
                        // Lower half: Translation along floor plane
                        if (camera && !touchStartWorldPosition && touchStartPositions.length > 0) {
                            const startNDC = new window.THREE.Vector2(
                                ((startPos.x - rect.left) / rect.width) * 2 - 1,
                                -((startPos.y - rect.top) / rect.height) * 2 + 1
                            );
                            const raycaster = new window.THREE.Raycaster();
                            raycaster.setFromCamera(startNDC, camera);
                            const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), 0);
                            touchStartWorldPosition = new window.THREE.Vector3();
                            raycaster.ray.intersectPlane(groundPlane, touchStartWorldPosition);
                            
                            const meshCenterOnGround = new window.THREE.Vector3(
                                mesh.position.x,
                                mesh.position.y,
                                mesh.position.z
                            );
                            this.dragOffset = new window.THREE.Vector3().subVectors(meshCenterOnGround, touchStartWorldPosition);
                            console.log('🟢 [TRANSLATE] Initialized drag offset');
                        }
                        
                        if (camera && touchStartWorldPosition && this.dragOffset) {
                            const currentNDC = new window.THREE.Vector2(
                                ((currentPos.x - rect.left) / rect.width) * 2 - 1,
                                -((currentPos.y - rect.top) / rect.height) * 2 + 1
                            );
                            
                            const raycaster = new window.THREE.Raycaster();
                            raycaster.setFromCamera(currentNDC, camera);
                            const groundPlane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), 0);
                            const currentIntersection = new window.THREE.Vector3();
                            raycaster.ray.intersectPlane(groundPlane, currentIntersection);
                            
                            const newMeshPosition = new window.THREE.Vector3().addVectors(
                                currentIntersection,
                                this.dragOffset || new window.THREE.Vector3(0, 0, 0)
                            );
                            
                            const oldPosition = mesh.position.clone();
                            mesh.position.set(newMeshPosition.x, 0, newMeshPosition.z);
                            
                            const worldDelta = new window.THREE.Vector3().subVectors(mesh.position, oldPosition);
                            if (worldDelta.length() > 0.001) {
                                console.log(`🟢 [TRANSLATE] Lower Half | Delta: (${worldDelta.x.toFixed(3)}, ${worldDelta.y.toFixed(3)}, ${worldDelta.z.toFixed(3)}) | New: (${mesh.position.x.toFixed(2)}, ${mesh.position.y.toFixed(2)}, ${mesh.position.z.toFixed(2)})`);
                            }
                            
                            mesh.updateMatrix();
                            mesh.updateMatrixWorld(true);
                            
                            if (this.arTransformControls) {
                                this.arTransformControls.updateMatrixWorld();
                            }
                        }
                    } else if (startIsUpperHalf) {
                        // Upper half: Rotation around up axis (Y-axis)
                        if (touchStartPositions.length > 0 && startPos) {
                            const startNDC = new window.THREE.Vector2(
                                ((startPos.x - rect.left) / rect.width) * 2 - 1,
                                -((startPos.y - rect.top) / rect.height) * 2 + 1
                            );
                            const currentNDC = new window.THREE.Vector2(
                                ((currentPos.x - rect.left) / rect.width) * 2 - 1,
                                -((currentPos.y - rect.top) / rect.height) * 2 + 1
                            );
                            
                            // Calculate rotation angle from horizontal movement
                            const deltaX = currentNDC.x - startNDC.x;
                            const rotationAngle = deltaX * Math.PI; // Scale factor for sensitivity
                            
                            if (Math.abs(rotationAngle) > 0.001) {
                                const rotationQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                                    new window.THREE.Vector3(0, 1, 0), // Y-axis (up)
                                    rotationAngle
                                );
                                
                                const oldRotation = mesh.rotation.y;
                                mesh.quaternion.multiplyQuaternions(rotationQuaternion, mesh.quaternion);
                                mesh.rotation.setFromQuaternion(mesh.quaternion);
                                
                                console.log(`🟡 [ROTATE] Upper Half | Delta: ${(rotationAngle * 180 / Math.PI).toFixed(2)}° | New: ${(mesh.rotation.y * 180 / Math.PI).toFixed(2)}°`);
                                
                                // Update start position for continuous rotation
                                touchStartPositions[0] = { ...currentPos };
                                
                                mesh.updateMatrix();
                                mesh.updateMatrixWorld(true);
                                
                                if (this.arTransformControls) {
                                    this.arTransformControls.updateMatrixWorld();
                                }
                            }
                        }
                    }
                } else if (numTouches === 2 && touchCount === 2) {
                    // Two finger gesture - determine if pinch (scale) or drag (rotate)
                    const currentDistance = getDistance(positions[0], positions[1]);
                    const distanceChange = Math.abs(currentDistance - touchStartDistance);
                    const currentCenter = getCenter(positions[0], positions[1]);
                    const centerMove = touchStartCenter ? getDistance(currentCenter, touchStartCenter) : 0;
                    
                    console.log(`🟣 [TWO-FINGER] Distance: ${currentDistance.toFixed(1)}px | Change: ${distanceChange.toFixed(1)}px | CenterMove: ${centerMove.toFixed(1)}px | StartDistance: ${touchStartDistance.toFixed(1)}px`);
                    
                    if (distanceChange > centerMove * 0.5) {
                        // Pinch gesture - scale
                        const scale = touchStartScale * (currentDistance / touchStartDistance);
                        const minScale = this.options.minScale || 0.1;
                        const maxScale = this.options.maxScale || 5.0;
                        const clampedScale = Math.max(minScale, Math.min(maxScale, scale));
                        const oldScale = mesh.scale.x;
                        mesh.scale.set(clampedScale, clampedScale, clampedScale);
                        console.log(`🔵 [PINCH/SCALE] Old: ${oldScale.toFixed(2)} | New: ${clampedScale.toFixed(2)} | Ratio: ${(currentDistance / touchStartDistance).toFixed(2)}`);
                        
                        // Update for continuous scaling
                        touchStartDistance = currentDistance;
                        touchStartScale = clampedScale;
                    } else {
                        // Rotate gesture - rotate around up axis (Y-axis for Y-up)
                        const currentAngle = getAngle(positions[0], positions[1]);
                        const angleDelta = currentAngle - touchStartRotation;
                        
                        if (Math.abs(angleDelta) > 0.01) { // Only rotate if significant change
                            // Apply rotation around Y-axis (up axis for Y-up coordinate system)
                            const rotationQuaternion = new window.THREE.Quaternion().setFromAxisAngle(
                                new window.THREE.Vector3(0, 1, 0),
                                angleDelta
                            );
                            
                            const oldRotation = mesh.rotation.y;
                            mesh.quaternion.multiplyQuaternions(rotationQuaternion, mesh.quaternion);
                            mesh.rotation.setFromQuaternion(mesh.quaternion);
                            console.log(`🟡 [ROTATE] Two-Finger | Delta: ${(angleDelta * 180 / Math.PI).toFixed(2)}° | Old: ${(oldRotation * 180 / Math.PI).toFixed(2)}° | New: ${(mesh.rotation.y * 180 / Math.PI).toFixed(2)}°`);
                            
                            // Update for continuous rotation
                            touchStartRotation = currentAngle;
                        }
                    }
                    
                    // Update touchStartPositions and center for continuous gestures
                    touchStartPositions = positions.map(p => ({ ...p }));
                    touchStartCenter = currentCenter;
                    
                    mesh.updateMatrix();
                    mesh.updateMatrixWorld(true);
                    
                    // Update transform controls
                    if (this.arTransformControls) {
                        this.arTransformControls.updateMatrixWorld();
                    }
                }
            } else if (event.type === 'touchend' || event.type === 'pointerup') {
                isDragging = false;
                touchStartPositions = [];
                touchCount = 0;
            }
        };
        
        // Add both touch and pointer events for compatibility
        // Add both touch and pointer events for compatibility
        // Use capture phase to intercept events before TransformControls
        canvas.addEventListener('touchstart', this.arGestureHandler, { passive: false, capture: true });
        canvas.addEventListener('touchmove', this.arGestureHandler, { passive: false, capture: true });
        canvas.addEventListener('touchend', this.arGestureHandler, { passive: false, capture: true });
        canvas.addEventListener('pointerdown', this.arGestureHandler, { capture: true });
        canvas.addEventListener('pointermove', this.arGestureHandler, { capture: true });
        canvas.addEventListener('pointerup', this.arGestureHandler, { capture: true });
    }

    cycleARTransformMode() {
        if (!this.arTransformControls) return;
        
        // Cycle through: translate -> rotate -> scale -> translate
        const modes = ['translate', 'rotate', 'scale'];
        const currentIndex = modes.indexOf(this.arTransformMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.arTransformMode = modes[nextIndex];
        this.arTransformControls.setMode(this.arTransformMode);
        
        const modeNames = {
            'translate': 'Move',
            'rotate': 'Rotate',
            'scale': 'Scale'
        };
        
        this.updateStatus(`AR mode: ${modeNames[this.arTransformMode]}. Tap to place, double-tap to switch mode.`);
    }

    moveSplatToPosition(hitPosition) {
        if (!this.viewer) return;
        
        const mesh = this.viewer.splatMesh || this.viewer.getSplatMesh?.();
        if (!mesh) return;
        
        // Position splat at hit point (ground level)
        // Use fixed offset of 0 - mesh origin is assumed to be at ground level
        mesh.position.set(
            hitPosition.x,
            hitPosition.y,
            hitPosition.z
        );
        
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        
        // Update transform controls if active
        if (this.arTransformControls) {
            this.arTransformControls.updateMatrixWorld();
        }
    }

    exitAR() {
        console.log('🔴 [EXIT AR] Exiting AR mode...');
        
        // Set flag to prevent select events during exit
        this._isExitingAR = true;
        
        // Important: End session FIRST before any cleanup
        // Three.js WebXRManager uses getSession(), not .session property
        // Also check our stored xrSession as fallback
        const session = this.renderer?.xr?.getSession?.() || this.xrSession;
        console.log('🔴 [EXIT AR] Session found:', !!session, 'via:', session === this.xrSession ? 'xrSession' : 'getSession()');
        
        if (session) {
            console.log('🔴 [EXIT AR] Calling session.end()...');
            session.end().then(() => {
                console.log('🔴 [EXIT AR] Session ended successfully');
            }).catch(e => {
                console.error('🔴 [EXIT AR] Session end failed:', e);
            });
        } else {
            console.warn('🔴 [EXIT AR] No session to end!');
        }
        
        // Stop AR frame loop
        this.arFrameLoopActive = false;
        
        // Performance optimization: Resume all other viewers when exiting AR
        // They were paused when this viewer entered AR
        for (const viewer of activeViewers) {
            if (viewer !== this && viewer._isPaused) {
                // Only resume if viewer is visible
                if (isContainerVisible(viewer.container)) {
                    viewer.resumeRendering();
                    console.log('Resumed other viewer after AR exit');
                }
            }
        }
        
        // Re-enable OrbitControls for desktop mode
        if (this.orbitControls) {
            this.orbitControls.enabled = true;
        }
        
        // Clean up hit-test sources
        if (this.hitTestSource) {
            try { this.hitTestSource.cancel(); } catch (e) {}
            this.hitTestSource = null;
        }
        if (this.initialHitSource) {
            try { this.initialHitSource.cancel(); } catch (e) {}
            this.initialHitSource = null;
        }
        
        // Clean up local-floor reference space
        this.localFloorReferenceSpace = null;
        this._refSpaceChecked = false; // Reset for next session
        
        // Save whether splat was placed before resetting
        const wasPlacedInAR = this.splatPlaced;
        
        this.splatPlaced = false;
        this.pendingHitPosition = null;
        this.pendingHitQuaternion = null;
        
        // Remove AR transform controls
        // TransformControls is not a THREE.Object3D, so we just dispose it
        if (this.arTransformControls) {
            // Detach from mesh if attached
            if (this.arTransformControls.object) {
                this.arTransformControls.detach();
            }
            this.arTransformControls.dispose();
            this.arTransformControls = null;
        }
        
        // Remove gesture handlers
        if (this.arGestureHandler && this.renderer && this.renderer.domElement) {
            const canvas = this.renderer.domElement;
            canvas.removeEventListener('touchstart', this.arGestureHandler);
            canvas.removeEventListener('touchmove', this.arGestureHandler);
            canvas.removeEventListener('touchend', this.arGestureHandler);
            canvas.removeEventListener('pointerdown', this.arGestureHandler);
            canvas.removeEventListener('pointermove', this.arGestureHandler);
            canvas.removeEventListener('pointerup', this.arGestureHandler);
            this.arGestureHandler = null;
        }
        
                // Remove tap event handlers
                if (this.arTapHandler && this.renderer && this.renderer.domElement) {
                    const canvas = this.renderer.domElement;
                    canvas.removeEventListener('click', this.arTapHandler);
                    canvas.removeEventListener('touchend', this.arTapHandler);
                    this.arTapHandler = null;
                }
                
                // Remove transient hit-test source
                if (this.transientHitTestSource) {
                    this.transientHitTestSource.cancel();
                    this.transientHitTestSource = null;
                }
                
                // Remove select event handlers
                if (this.xrSession) {
                    this.xrSession.removeEventListener('selectstart', this.onSelectStart);
                    this.xrSession.removeEventListener('selectend', this.onSelectEnd);
                }
                
                // Reset gesture state
                this.isTranslating = false;
                this.isRotating = false;
                this.isTwoHandInteraction = false;
                this.inputSource = null;
                this.lastDragPosition = null;
                this.frame = null;
        
        // Remove AR reticle
        if (this.reticle && this.scene) {
            this.scene.remove(this.reticle);
            this.reticle = null;
        }
        
        // Remove manipulation feedback ring
        if (this.manipulationRingHideTimeout) {
            clearTimeout(this.manipulationRingHideTimeout);
            this.manipulationRingHideTimeout = null;
        }
        if (this.manipulationRing && this.scene) {
            this.scene.remove(this.manipulationRing);
            this.manipulationRing = null;
            this.manipulationRingFadeStartTime = 0;
        }
        
        // Remove debug floor plane
        if (this.debugFloorPlane && this.scene) {
            this.scene.remove(this.debugFloorPlane);
            this.debugFloorPlane = null;
        }
        
        // Ensure splat mesh is visible and in scene for desktop mode
        if (this.splatMesh) {
            console.log('🔴 [EXIT AR] Restoring splat mesh for desktop mode');
            
            // Ensure mesh is in scene
            if (!this.splatMesh.parent && this.scene) {
                this.scene.add(this.splatMesh);
            }
            
            // Always apply desktop transform when returning to desktop mode
            // This resets the splat to the center for proper viewing
            this.applyTransformToMesh(this.splatMesh, 'desktop');
            
            // Make sure mesh is visible (same as initial load)
            this.splatMesh.visible = true;
            
            // Force matrix update (same as initial load)
            this.splatMesh.updateMatrix();
            this.splatMesh.updateMatrixWorld(true);
            
            console.log('🔴 [EXIT AR] Applied desktop transform, position:', 
                this.splatMesh.position.toArray().map(v => v.toFixed(2)));
        }
        
        // Clear session reference - the 'end' event listener set up during session creation
        // will handle cleanup via exitARMode() and onAREnd()
        this.xrSession = null;
        
        // Reset flag after a delay (session 'end' event will also call exitARMode/onAREnd)
        setTimeout(() => {
            this._isExitingAR = false;
            
            // Update renderer size and camera aspect ratio (same as initial load)
            if (this.renderer && this.container) {
                // Ensure container has dimensions - use window as fallback
                let width = this.container.clientWidth;
                let height = this.container.clientHeight;
                
                // If container has zero dimensions, use window dimensions
                if (!width || width === 0) {
                    width = window.innerWidth;
                }
                if (!height || height === 0) {
                    height = window.innerHeight;
                }
                
                // Update camera aspect ratio
                if (this.camera && width > 0 && height > 0) {
                    this.camera.aspect = width / height;
                    this.camera.updateProjectionMatrix();
                }
                
                // Update renderer size
                if (width > 0 && height > 0) {
                    this.renderer.setSize(width, height);
                    this.renderer.setPixelRatio(window.devicePixelRatio);
                    console.log('🔴 [EXIT AR] Renderer size updated:', { width, height, containerWidth: this.container.clientWidth, containerHeight: this.container.clientHeight });
                } else {
                    console.warn('🔴 [EXIT AR] Container has zero dimensions, using window size');
                    this.renderer.setSize(window.innerWidth, window.innerHeight);
                    this.renderer.setPixelRatio(window.devicePixelRatio);
                }
            }
            
            // Restore desktop animation loop (same as initial load)
            if (this.desktopAnimationLoop && this.renderer) {
                this.renderer.setAnimationLoop(this.desktopAnimationLoop);
            } else if (this.renderer) {
                // Fallback: recreate desktop loop if it was lost
                this.setupAnimationLoop();
            }
            
            // Restore OrbitControls for desktop mode (same as initial load)
            this.setupOrbitControls();
            
            // Re-apply camera transform when exiting AR (same as initial load)
            this.applyCameraTransform();
            
            // Ensure mesh is visible and properly set up (same as initial load)
            if (this.splatMesh) {
                // Double-check mesh is in scene
                if (!this.splatMesh.parent && this.scene) {
                    this.scene.add(this.splatMesh);
                }
                
                // Ensure visibility (same as initial load after transform)
                this.splatMesh.visible = true;
                
                // Force matrix update one more time
                this.splatMesh.updateMatrix();
                this.splatMesh.updateMatrixWorld(true);
            }
            
            // Force an immediate render to ensure mesh is visible (same as initial load)
            if (this.renderer && this.scene && this.camera && !this.renderer.xr.isPresenting) {
                this.renderer.render(this.scene, this.camera);
            }
            
            console.log('🔴 [EXIT AR] Desktop mode restored', {
                meshVisible: this.splatMesh?.visible,
                meshInScene: !!this.splatMesh?.parent,
                animationLoop: !!this.desktopAnimationLoop,
                orbitControls: !!this.orbitControls?.enabled
            });
        }, 100);

        if (this.xrButton) {
            this.xrButton.classList.remove('hidden');
            this.xrButton.style.display = ''; // Remove inline display:none
            this.xrButton.disabled = false; // Re-enable the button
        }
        this.updateStatus('Exited AR mode.');
    }

    onWindowResize() {
        // Don't resize during AR mode (WebXR handles this)
        if (this.xrSession && this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
            return;
        }
        
        if (this.renderer && this.camera && this.container) {
            // Get container dimensions, with fallback to window size
            let width = this.container.clientWidth || window.innerWidth;
            let height = this.container.clientHeight || window.innerHeight;
            
            // Ensure we have valid dimensions
            if (width > 0 && height > 0) {
                // Update camera aspect ratio
                this.camera.aspect = width / height;
                this.camera.updateProjectionMatrix();
                
                // Update renderer size
                this.renderer.setSize(width, height);
                this.renderer.setPixelRatio(window.devicePixelRatio);
            }
        }
    }

    updateStatus(message) {
        // In AR mode, don't override the UX flow prompts (model-viewer style)
        // The scanning/placing/placed prompts are managed separately
        if (this.renderer?.xr?.isPresenting) {
            // Only show critical error messages in AR mode
            if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
                this.showARPrompt(message);
            }
            return;
        }
        
        if (this.statusDiv) {
            // Clear any existing fade timeout
            if (this.statusFadeTimeout) {
                clearTimeout(this.statusFadeTimeout);
                this.statusFadeTimeout = null;
            }
            
            // Remove hidden class and show
            this.statusDiv.classList.remove('hidden');
            this.statusDiv.textContent = message;
            
            // Auto-hide success messages
            const fadeOutMessages = [
                'Gaussian splat loaded successfully!',
                'AR session ended',
                'Exited AR mode.'
            ];
            
            if (fadeOutMessages.some(m => message.includes(m))) {
                // Move to corner for non-intrusive display
                this.statusDiv.classList.add('corner');
                
                this.statusFadeTimeout = setTimeout(() => {
                    if (this.statusDiv) {
                        this.statusDiv.classList.add('hidden');
                    }
                    this.statusFadeTimeout = null;
                }, 3000);
            }
        }
        console.log('Status:', message);
    }

    dispose() {
        // Remove from global registry
        activeViewers.delete(this);
        
        // Disconnect visibility observer
        if (this._visibilityObserver) {
            this._visibilityObserver.disconnect();
            this._visibilityObserver = null;
        }
        
        // Stop animation loop
        if (this.renderer) {
            this.renderer.setAnimationLoop(null);
        }
        
        // Clean up AR session if still active
        if (this.xrSession) {
            try {
                this.xrSession.end();
            } catch (e) {
                console.warn('Error ending XR session during dispose:', e);
            }
            this.xrSession = null;
        }
        // Clean up MutationObserver
        if (this.arButtonObserver) {
            this.arButtonObserver.disconnect();
            this.arButtonObserver = null;
        }
        
        // Remove resize event listener
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }
        
        if (this.viewer && this.viewer.dispose) {
            this.viewer.dispose();
        }
        window.removeEventListener('resize', () => this.onWindowResize());
    }
}

/**
 * Parse a Vector3 value from attribute (comma-separated or JSON array)
 * @param {string} attrValue - Attribute value
 * @returns {{x: number, y: number, z: number}|null}
 */
function parseVector3(attrValue) {
    if (!attrValue) return null;
    
    try {
        // Try parsing as JSON array first
        const parsed = JSON.parse(attrValue);
        if (Array.isArray(parsed) && parsed.length >= 3) {
            return { x: parseFloat(parsed[0]) || 0, y: parseFloat(parsed[1]) || 0, z: parseFloat(parsed[2]) || 0 };
        }
    } catch (e) {
        // Not JSON, try comma-separated
    }
    
    // Parse as comma-separated values
    const parts = attrValue.split(',').map(s => s.trim());
    if (parts.length >= 3) {
        return {
            x: parseFloat(parts[0]) || 0,
            y: parseFloat(parts[1]) || 0,
            z: parseFloat(parts[2]) || 0
        };
    }
    
    return null;
}

/**
 * Parse a boolean value from attribute
 * @param {string} attrValue - Attribute value
 * @returns {boolean}
 */
function parseBoolean(attrValue) {
    if (!attrValue) return false;
    const lower = attrValue.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
}

/**
 * Sanitize scene name to prevent path traversal
 * @param {string} input - Input string
 * @returns {string} - Sanitized string
 */
function sanitizeSceneName(input) {
    if (!input || typeof input !== 'string') {
        return null; // Return null instead of default to avoid hardcoded fallback
    }
    // Remove any path separators, special characters, and limit length
    // Only allow alphanumeric, underscore, hyphen, and dots (for extensions)
    const sanitized = input.replace(/[^a-zA-Z0-9._-]/g, '').substring(0, 100);
    // Remove leading dots to prevent hidden files
    const result = sanitized.replace(/^\.+/, '');
    return result || null; // Return null instead of default
}

/**
 * Parse transform attributes from container element
 * @param {HTMLElement} container - Container element
 * @param {string} prefix - Prefix for attributes ('transform' or 'transform-ar')
 * @returns {Object|null} - Transform object with scale, position, rotate
 */
function parseTransform(container, prefix) {
    const scale = parseVector3(container.getAttribute(`${prefix}-scale`));
    const position = parseVector3(container.getAttribute(`${prefix}-position`));
    const rotate = parseVector3(container.getAttribute(`${prefix}-rotate`));
    
    if (!scale && !position && !rotate) {
        return null;
    }
    
    return {
        scale: scale || { x: 1, y: 1, z: 1 },
        position: position || { x: 0, y: 0, z: 0 },
        rotate: rotate || { x: 0, y: 0, z: 0 }
    };
}

/**
 * Parse camera configuration from container element
 * @param {HTMLElement} container - Container element
 * @returns {Object|null} - Camera config with position and lookAt
 */
function parseCameraConfig(container) {
    const position = parseVector3(container.getAttribute('camera-position'));
    const lookAt = parseVector3(container.getAttribute('camera-look-at'));
    
    if (!position && !lookAt) {
        return null;
    }
    
    // Convert lookAt object to array format if it exists
    const lookAtArray = lookAt ? [lookAt.x, lookAt.y, lookAt.z] : [0, 0, 0];
    
    return {
        cameraPosition: position || { x: 0, y: 0, z: 10 },
        cameraLookAt: lookAtArray
    };
}

/**
 * Parse all attributes from container element
 * @param {HTMLElement} container - Container element
 * @returns {Object} - Configuration object
 */
function parseAttributes(container) {
    const config = {};
    
    // Parse splat source
    const splatSrc = container.getAttribute('splat-src');
    console.log('parseAttributes: splat-src attribute =', splatSrc, 'for element:', container);
    if (splatSrc) {
        config.splatFile = splatSrc;
        console.log('parseAttributes: set config.splatFile =', config.splatFile);
    } else {
        console.warn('parseAttributes: No splat-src attribute found on element:', container);
    }
    
    // Parse enable AR
    const enableAR = container.getAttribute('enable-ar');
    if (enableAR !== null) {
        config.enableAR = parseBoolean(enableAR);
    }
    
    // Parse show FPS
    const fps = container.getAttribute('fps');
    if (fps !== null) {
        config.showFPS = parseBoolean(fps);
    }
    
    // Parse theme (dark or light)
    const theme = container.getAttribute('theme');
    if (theme) {
        const themeLower = theme.toLowerCase().trim();
        if (themeLower === 'dark' || themeLower === 'light') {
            config.theme = themeLower;
        }
    }
    
    // Parse min-scale and max-scale for pinch/zoom gestures
    const minScaleAttr = container.getAttribute('min-scale');
    if (minScaleAttr !== null) {
        const minScale = parseFloat(minScaleAttr);
        if (!isNaN(minScale) && minScale > 0) {
            config.minScale = minScale;
        }
    }
    
    const maxScaleAttr = container.getAttribute('max-scale');
    if (maxScaleAttr !== null) {
        const maxScale = parseFloat(maxScaleAttr);
        if (!isNaN(maxScale) && maxScale > 0) {
            config.maxScale = maxScale;
        }
    }
    
    // Parse camera config
    const cameraConfig = parseCameraConfig(container);
    if (cameraConfig) {
        config.cameraPosition = cameraConfig.cameraPosition;
        config.cameraLookAt = cameraConfig.cameraLookAt;
    }
    
    // Parse desktop transform
    const desktopTransform = parseTransform(container, 'transform');
    if (desktopTransform) {
        config.transform = {
            scale: desktopTransform.scale,
            position: desktopTransform.position,
            rotate: desktopTransform.rotate,
            cameraPosition: config.cameraPosition,
            cameraLookAt: config.cameraLookAt
        };
    }
    
    // Parse AR transform
    const arTransform = parseTransform(container, 'transform-ar');
    if (arTransform) {
        config.transformAr = arTransform;
    }
    
    return config;
}

/**
 * Parse URL parameters
 * @returns {Object} - Configuration object from URL params
 */
function parseURLParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const config = {};
    
    const sceneName = sanitizeSceneName(urlParams.get('scene'));
    if (sceneName) {
        config.splatFile = `${sceneName}.splat`;
    }
    // Only set splatFile if scene parameter exists and is valid
    
    const xrMode = urlParams.get('xr');
    if (xrMode) {
        const validModes = ['ar', 'vr', 'none'];
        const lower = xrMode.toLowerCase().trim();
        if (validModes.includes(lower)) {
            config.enableAR = lower === 'ar';
        }
    }
    
    return config;
}

/**
 * Get default configuration
 * @returns {Object} - Default configuration
 */
function getDefaultConfig() {
    return {
        splatFile: null, // No default - must be provided via splat-src attribute
        enableAR: true,
        useBuiltInControls: false,
        theme: 'dark', // Default theme: 'dark' or 'light'
        minScale: 0.1, // Minimum scale for pinch/zoom gestures
        maxScale: 5.0, // Maximum scale for pinch/zoom gestures
        transform: {
            cameraLookAt: [0, 0, 25],
            cameraPosition: { x: 0, y: 3, z: 5 },
            scale: { x: 1.0, y: 1.0, z: 1.0 },
            position: { x: 0.0, y: 0.0, z: 0.0 },
            rotate: { x: 0.0, y: 0.0, z: 0.0 }
        },
        transformAr: {
            scale: { x: 1.0, y: 1.0, z: 1.0 },
            position: { x: 0.0, y: 0.0, z: 0.0 },
            rotate: { x: 0.0, y: 0.0, z: 0.0 }
        },
        transformVr: {
            scale: { x: 0.1, y: 0.1, z: 0.1 },
            position: { x: 0.0, y: 0.0, z: 0.0 },
            rotate: { x: 0.0, y: 0.0, z: 0.0 }
        }
    };
}

/**
 * Merge configurations with priority: URL > attributes > defaults
 * @param {Object} defaults - Default configuration
 * @param {Object} attributes - Configuration from HTML attributes
 * @param {Object} urlParams - Configuration from URL parameters
 * @returns {Object} - Merged configuration
 */
function mergeConfig(defaults, attributes, urlParams) {
    const config = { ...defaults };
    
    // Merge attributes (override defaults)
    if (attributes.splatFile) config.splatFile = attributes.splatFile;
    if (attributes.enableAR !== undefined) config.enableAR = attributes.enableAR;
    if (attributes.showFPS !== undefined) config.showFPS = attributes.showFPS;
    if (attributes.theme) config.theme = attributes.theme;
    if (attributes.minScale !== undefined) config.minScale = attributes.minScale;
    if (attributes.maxScale !== undefined) config.maxScale = attributes.maxScale;
    if (attributes.transform) {
        config.transform = { ...config.transform, ...attributes.transform };
    }
    if (attributes.transformAr) {
        config.transformAr = { ...config.transformAr, ...attributes.transformAr };
    }
    if (attributes.cameraPosition) {
        if (!config.transform) config.transform = {};
        config.transform.cameraPosition = attributes.cameraPosition;
    }
    if (attributes.cameraLookAt) {
        if (!config.transform) config.transform = {};
        config.transform.cameraLookAt = attributes.cameraLookAt;
    }
    
    // Merge URL params (override everything)
    if (urlParams.splatFile) config.splatFile = urlParams.splatFile;
    if (urlParams.enableAR !== undefined) config.enableAR = urlParams.enableAR;
    
    return config;
}

/**
 * Inject splat-viewer CSS styles into document head
 * Only injects once, even if multiple elements exist
 */
function injectSplatViewerStyles() {
    if (document.getElementById('splat-viewer-styles')) {
        return; // Already injected
    }

    const style = document.createElement('style');
    style.id = 'splat-viewer-styles';
    style.textContent = `
        /* Critical: html and body dimensions (dependencies) */
        /* Note: height and overflow are NOT set here - let each page control these */
        html, body {
            width: 100%;
            margin: 0;
            padding: 0;
        }

        /* Critical: splat-viewer element dimensions */
        splat-viewer {
            display: block;
            width: 100%;
            min-height: 100vh;
            height: 100vh;
            position: relative;
            box-sizing: border-box;
            overflow: visible; /* Ensure AR button and other UI elements are not clipped */
        }
        
        /* Mobile landscape: ensure minimum height for proper display */
        @media (max-height: 500px) and (orientation: landscape) {
            splat-viewer {
                min-height: 500px;
                height: auto;
            }
        }
        
        /* When splat-viewer is not full viewport, use auto height */
        splat-viewer:not([style*="height: 100vh"]) {
            height: auto;
            min-height: 400px;
        }

        /* Critical: canvas-container dimensions */
        #canvas-container {
            width: 100%;
            height: 100%;
            min-height: 100%;
            position: relative;
            overflow: visible; /* Don't clip UI elements like AR button */
        }
        
        /* Mobile landscape: ensure canvas container has minimum height */
        @media (max-height: 500px) and (orientation: landscape) {
            #canvas-container {
                min-height: 500px;
            }
        }

        /* Critical: canvas sizing */
        #canvas-container canvas {
            display: block;
            width: 100%;
            height: 100%;
            touch-action: none;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 1; /* Ensure canvas is below UI elements */
            pointer-events: auto; /* Canvas should receive pointer events */
        }

        /* AR Button - matches model-viewer's style */
        /* Positioned relative to splat-viewer container, always at bottom right */
        .ar-button {
            background: #fff;
            border-radius: 4px;
            border: none;
            box-shadow: 0 2px 4px rgba(0,0,0,0.25);
            color: #4285f4;
            cursor: pointer;
            display: block;
            font-family: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 14px;
            font-weight: 500;
            height: 36px;
            line-height: 36px;
            padding: 0 16px;
            position: absolute;
            bottom: 16px;
            right: 16px;
            text-align: center;
            transition: background-color 0.2s, box-shadow 0.2s;
            white-space: nowrap;
            z-index: 10000;
            pointer-events: auto; /* Ensure button is clickable */
            /* Ensure button is always visible and not clipped */
            visibility: visible;
            opacity: 1;
        }
        
        /* For full-page containers (direct child of body) on mobile, use fixed positioning */
        /* This ensures button is positioned relative to viewport, not container */
        /* Fixed positioning accounts for dynamic viewport height on mobile browsers */
        @media (max-width: 768px) and (hover: none) {
            body > splat-viewer .ar-button {
                position: fixed; /* Use fixed positioning on mobile full-page */
                bottom: 16px;
                right: 16px;
            }
        }
        
        /* For smaller containers (not full-page), keep absolute positioning */
        /* This ensures consistency for embedded viewers like in test-example.html */

        .ar-button:hover {
            background: #f8f8f8;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        }

        .ar-button:active {
            background: #e8e8e8;
        }

        .ar-button:disabled {
            background: #eee;
            color: #999;
            cursor: not-allowed;
            box-shadow: none;
        }

        .ar-button.hidden {
            display: none;
        }

        /* AR Overlay - shown during AR session */
        #ar-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 9999;
            display: none;
        }

        #ar-overlay.active {
            display: block;
        }

        /* AR Prompt - model-viewer style (no backdrop) */
        #ar-prompt {
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: transparent;
            color: white;
            padding: 12px 24px;
            border-radius: 24px;
            font-size: 14px;
            font-weight: 500;
            text-align: center;
            white-space: nowrap;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s;
            z-index: 10001;
            text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
        }

        #ar-prompt.visible {
            opacity: 1;
        }

        /* AR Hand Prompt - model-viewer style (no backdrop) */
        #ar-hand-prompt {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
            z-index: 10001;
            display: flex;
            flex-direction: column;
            align-items: center;
            background: transparent;
            padding: 0;
        }

        #ar-hand-prompt.visible {
            opacity: 1;
        }

        #ar-hand-prompt .phone-icon {
            width: 64px;
            height: 64px;
            animation: phoneMove 1.4s ease-in-out infinite;
            filter: drop-shadow(0 2px 8px rgba(0,0,0,0.8));
        }

        #ar-hand-prompt .scan-text {
            color: white;
            font-size: 14px;
            font-weight: 500;
            margin-top: 16px;
            text-align: center;
            max-width: 250px;
            text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
        }

        @keyframes phoneMove {
            0%, 100% { transform: translateY(0) rotate(-10deg); }
            50% { transform: translateY(-20px) rotate(10deg); }
        }

        /* Exit AR Button - simple white X button */
        #exit-ar-btn {
            position: fixed;
            top: 16px;
            right: 16px;
            width: 40px;
            height: 40px;
            background: transparent;
            border: none;
            color: white;
            font-size: 20px;
            font-weight: normal;
            cursor: pointer;
            display: none;
            align-items: center;
            justify-content: center;
            pointer-events: auto;
            z-index: 10002;
            transition: opacity 0.2s;
        }

        #exit-ar-btn:hover {
            opacity: 0.7;
        }

        #exit-ar-btn.visible {
            display: flex;
        }

        /* Loading/Status - minimal style (no backdrop) */
        #status {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: transparent;
            padding: 16px 24px;
            border-radius: 8px;
            font-size: 14px;
            text-align: center;
            z-index: 10000;
            max-width: 80%;
            transition: opacity 0.3s;
        }
        
        /* Dark theme (default) */
        #status.theme-dark {
            color: white;
            text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
        }
        
        /* Light theme */
        #status.theme-light {
            color: #1a1a1a;
            text-shadow: 0 2px 8px rgba(255, 255, 255, 0.8);
        }

        #status.hidden {
            opacity: 0;
            pointer-events: none;
        }

        #status.corner {
            top: 16px;
            left: auto;
            right: 16px;
            transform: none;
            padding: 8px 12px;
            font-size: 12px;
            background: transparent;
        }

        /* Desktop controls hint */
        #controls-hint {
            position: absolute;
            bottom: 16px;
            left: 16px;
            font-size: 12px;
            z-index: 100;
            opacity: 1;
            transition: opacity 0.5s ease-out;
        }
        
        /* Dark theme (default) */
        #controls-hint.theme-dark {
            color: rgba(255, 255, 255, 0.6);
        }
        
        /* Light theme */
        #controls-hint.theme-light {
            color: rgba(0, 0, 0, 0.6);
        }

        #controls-hint.hidden {
            opacity: 0;
            pointer-events: none;
        }
        
        /* FPS Stats display - positioned at top-left of splat-viewer container */
        .splat-viewer-stats {
            position: absolute;
            top: 16px;
            left: 16px;
            z-index: 10001;
            pointer-events: auto;
        }
        
        /* For full-page containers (direct child of body) on mobile, use fixed positioning */
        /* This ensures stats are positioned relative to viewport, not container */
        @media (max-width: 768px) and (hover: none) {
            body > splat-viewer .splat-viewer-stats {
                position: fixed; /* Use fixed positioning on mobile full-page */
                top: 16px;
                left: 16px;
            }
        }
        
        /* For smaller containers (not full-page), keep absolute positioning */
        /* This ensures consistency for embedded viewers like in test-example.html */
    `;
    document.head.appendChild(style);
}

/**
 * Custom Web Component for Splat Viewer
 * Similar to model-viewer's approach
 */
class SplatViewerElement extends HTMLElement {
    constructor() {
        super();
        this.viewer = null;
        this._initialized = false;
    }

    connectedCallback() {
        if (this._initialized) return;
        this._initialized = true;

        // Inject styles if not already injected
        injectSplatViewerStyles();

        // Create internal structure
        this._createInternalStructure();

        // Parse configuration from attributes
        const defaults = getDefaultConfig();
        const attributes = parseAttributes(this);
        const urlParams = parseURLParams();
        const config = mergeConfig(defaults, attributes, urlParams);
        
        // Debug: Log configuration to help diagnose issues
        if (!config.splatFile) {
            console.warn('SplatViewer: No splat file specified. Attributes:', {
                'splat-src': this.getAttribute('splat-src'),
                parsedAttributes: attributes,
                mergedConfig: config
            });
        }

        // Get container for the viewer (use light DOM, not shadow DOM)
        const container = this.querySelector('#canvas-container') || this;

        // Initialize SplatViewer
        this.viewer = new SplatViewer(container, config);
        this.viewer.init().catch(error => {
            console.error('Failed to initialize viewer:', error);
            const statusDiv = this.querySelector('#status');
            if (statusDiv) {
                statusDiv.textContent = `Error: ${error.message || 'Failed to initialize viewer'}`;
            }
        });

        // Make viewer available on element
        this.splatViewer = this.viewer;

        // Make first viewer available globally
        if (!window.splatViewer) {
            window.splatViewer = this.viewer;
        }
    }

    disconnectedCallback() {
        if (this.viewer && this.viewer.dispose) {
            this.viewer.dispose();
        }
    }

    _createInternalStructure() {
        // Set element styles
        this.style.display = 'block';
        this.style.position = 'relative';
        this.style.width = '100%';
        this.style.height = '100%';
        this.style.minHeight = '400px';
        this.style.overflow = 'visible'; // Ensure AR button and UI elements are not clipped

        // Create canvas container
        const container = document.createElement('div');
        container.id = 'canvas-container';
        // Ensure container has proper dimensions
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.position = 'relative';
        container.style.overflow = 'visible'; // Don't clip UI elements
        this.appendChild(container);

        // Create status div
        const statusDiv = document.createElement('div');
        statusDiv.id = 'status';
        statusDiv.textContent = 'Loading...';
        this.appendChild(statusDiv);

        // Create controls hint
        const controlsHint = document.createElement('div');
        controlsHint.id = 'controls-hint';
        controlsHint.innerHTML = '<span>🖱️ Drag to rotate • Scroll to zoom</span>';
        this.appendChild(controlsHint);

        // Create AR button
        const arButton = document.createElement('button');
        arButton.id = 'enter-ar-btn';
        arButton.className = 'ar-button hidden';
        arButton.textContent = 'View in AR';
        this.appendChild(arButton);

        // Create AR overlay
        const arOverlay = document.createElement('div');
        arOverlay.id = 'ar-overlay';
        arOverlay.innerHTML = `
            <div id="ar-hand-prompt">
                <svg class="phone-icon" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>
                </svg>
                <span class="scan-text">Move your phone to find the floor</span>
            </div>
            <div id="ar-prompt">Tap to place</div>
            <button id="exit-ar-btn">✕</button>
        `;
        this.appendChild(arOverlay);
    }
}

// Register the custom element
customElements.define('splat-viewer', SplatViewerElement);


