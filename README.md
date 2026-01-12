# SplatViewer v0.1

A vibe-coded WebXR-based augmented reality viewer for 3D Gaussian Splat files. Built as a custom web component with a clean, attribute-based API similar to `model-viewer`, this viewer enables immersive AR experiences on mobile devices and provides interactive desktop viewing with camera controls.

use at own your risk ;)

## Features

- **Custom Web Component**: Simple `<splat-viewer>` tag with attribute-based configuration
- **AR Mode**: Full WebXR AR support with hit-testing, floor detection, and gesture controls
- **Desktop Mode**: Interactive 3D viewing with orbit controls
- **Sandboxed Deployment**: All dependencies bundled locally in `src/` folder
- **Attribute-Based API**: Configure via HTML attributes (no JavaScript required)
- **Separate Transforms**: Independent transforms for desktop and AR modes
- **Camera Configuration**: Customizable camera position and look-at target
- **Production Ready**: Content Security Policy (CSP) configured for secure deployment

## Quick Start

### Installation

1. Clone or download this repository
2. Place your `.splat` files in the project directory
3. Use the `<splat-viewer>` custom element in your HTML

### Basic Usage

```html
<splat-viewer
    splat-src="your-file.splat"
    camera-position="0,3,5"
    camera-look-at="0,0,0"
    transform-scale="0.5,0.5,0.5"
    enable-ar="true">
</splat-viewer>

<script type="module" src="splat-viewer.js"></script>
```

That's it! The viewer handles all initialization, UI, and controls automatically.

## API Reference

### Attributes

#### Core Attributes

- **`splat-src`** (required): Path to the splat file (supports `.splat`, `.sog`, `.ply`, `.spz` formats)
  - Example: `splat-src="scene.splat"` or `splat-src="model.sog"`

- **`enable-ar`** (optional): Enable/disable AR mode button
  - Values: `"true"` | `"false"` (default: `"true"`)

- **`fps`** (optional): Show FPS performance monitor
  - Values: `"true"` | `"false"` (default: `"false"`)
  - Shows a performance monitor in the top-left corner with FPS, MS (milliseconds per frame), and MB (memory usage)
  - Click the monitor to cycle through different panels

- **`theme`** (optional): UI theme for status messages and controls
  - Values: `"dark"` | `"light"` (default: `"dark"`)
  - Applies to status messages and control hints in desktop mode

#### Camera Configuration

- **`camera-position`**: Initial camera position in desktop mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,3,5"`)
  - Example: `camera-position="0,5,10"`

- **`camera-look-at`**: Camera target point in desktop mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,0,0"`)
  - Example: `camera-look-at="0,0,0"`

#### Desktop Transform

- **`transform-scale`**: Scale for desktop mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"1,1,1"`)
  - Example: `transform-scale="0.5,0.5,0.5"`

- **`transform-position`**: Position offset for desktop mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,0,0"`)
  - Example: `transform-position="0,0,0"`

- **`transform-rotate`**: Rotation in degrees for desktop mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,0,0"`)
  - Example: `transform-rotate="180,0,0"`

#### AR Transform

- **`transform-ar-scale`**: Scale for AR mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0.1,0.1,0.1"`)
  - Example: `transform-ar-scale="0.1,0.1,0.1"`

- **`transform-ar-position`**: Position offset for AR mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,0,0"`)
  - Example: `transform-ar-position="0,0,0"`

- **`transform-ar-rotate`**: Rotation in degrees for AR mode
  - Format: `"x,y,z"` or `"[x,y,z]"` (default: `"0,0,0"`)
  - Example: `transform-ar-rotate="180,0,0"`

#### Gesture Configuration

- **`min-scale`**: Minimum scale limit for pinch/zoom gestures in AR mode
  - Format: Number (default: `0.1`)
  - Example: `min-scale="0.05"` (allows scaling down to 5% of original size)
  - Applies to all scaling gestures: XR input sources, touch gestures, and pointer events

- **`max-scale`**: Maximum scale limit for pinch/zoom gestures in AR mode
  - Format: Number (default: `5.0`)
  - Example: `max-scale="5.0"` (allows scaling up to 500% of original size)
  - Applies to all scaling gestures: XR input sources, touch gestures, and pointer events

### Complete Example

```html
<splat-viewer
    splat-src="SatsumaVase.splat"
    camera-position="0,2,2"
    camera-look-at="0,0.8,0"
    transform-scale="0.1,0.1,0.1"
    transform-position="0,0,0"
    transform-rotate="180,0,0"
    transform-ar-scale="0.1,0.1,0.1"
    transform-ar-position="0,0,0"
    transform-ar-rotate="180,0,0"
    min-scale="0.05"
    max-scale="5.0"
    enable-ar="true"
    fps="true"
    theme="light">
</splat-viewer>
```

## Controls

### AR Mode (Mobile)

- **Tap to Place**: Tap anywhere to place the splat at the detected floor location
- **Single-finger drag (lower 2/3 of screen)**: Translate splat on ground plane
- **Single-finger drag (upper 1/3 of screen)**: Rotate splat around Y-axis
- **Two-finger pinch**: Scale splat (relative to current size, constrained by `min-scale` and `max-scale` attributes)
- **Exit button (top-right)**: Exit AR mode and return to desktop view

**Note**: Scaling limits can be configured using the `min-scale` and `max-scale` attributes. The default limits are 0.1 (10%) to 5.0 (500%) of the original size.

### Desktop Mode

- **Left-click + drag**: Rotate camera around the target point
- **Right-click + drag**: Pan camera
- **Scroll wheel**: Zoom in/out
- **Touch gestures**: Multi-touch gestures supported on touch devices

## Technologies Used

- **Spark.js** (`@sparkjsdev/spark` v0.1.10): High-performance library for rendering Gaussian Splat point clouds with optimized GPU acceleration and WebXR integration
- **Three.js** (v0.178.0): Industry-standard 3D graphics library providing WebGL rendering, camera controls, and scene management
- **WebXR API**: Native browser API for immersive AR/VR experiences, enabling spatial tracking and hit-testing
- **ES6 Modules**: Modern JavaScript module system for clean code organization
- **Web Components**: Custom HTML elements for declarative usage
- **WebGL 2.0**: Hardware-accelerated graphics rendering for real-time performance

## Architecture

### Sandboxed Deployment

All external dependencies are bundled locally in the `src/` folder for fully sandboxed deployment:

```
src/
├── three/
│   ├── three.module.js      # Three.js main library
│   ├── three.core.js        # Three.js core (required by three.module.js)
│   └── addons/
│       ├── controls/
│       │   ├── OrbitControls.js
│       │   └── TransformControls.js
│       └── webxr/
│           ├── ARButton.js
│           └── XRPlanes.js
└── spark/
    └── spark.module.js      # Spark.js library
```

The application uses an import map to resolve dependencies, and the Content Security Policy (CSP) restricts external connections, ensuring secure, offline-capable deployment.

### Custom Web Component

The viewer is implemented as a custom web component (`<splat-viewer>`) that:
- Automatically creates all UI elements (canvas, buttons, status messages)
- Handles initialization and lifecycle management
- Parses configuration from HTML attributes
- Manages AR session lifecycle
- Provides clean separation between desktop and AR modes

## Browser & Device Compatibility

### AR Mode Support

| Platform | Browser | AR Support | Notes |
|----------|---------|------------|-------|
| **Android** | Chrome/Edge | ✅ Full Support | Recommended platform |
| **Android** | Samsung Internet | ✅ Full Support | WebXR enabled |
| **Android** | Firefox | ⚠️ Limited | May have compatibility issues |
| **iOS** | Safari | ❌ Not Supported | WebXR not available |
| **iOS** | Chrome/Edge | ❌ Not Supported | Uses Safari engine |
| **Desktop** | Chrome/Edge | ⚠️ Experimental | Limited AR device support |
| **Desktop** | Firefox | ❌ Not Supported | No WebXR AR support |

### Desktop Viewing Mode

| Platform | Browser | Support | Notes |
|----------|---------|---------|-------|
| **Windows** | Chrome/Edge | ✅ Full Support | Recommended |
| **Windows** | Firefox | ✅ Full Support | |
| **macOS** | Safari | ✅ Full Support | |
| **macOS** | Chrome/Edge | ✅ Full Support | |
| **Linux** | Chrome/Edge | ✅ Full Support | |
| **Linux** | Firefox | ✅ Full Support | |

## File Format

The viewer supports all file formats that Spark.js supports:
- **`.splat`**: Binary Gaussian Splat format
- **`.sog`**: Compressed splat format (recommended for web deployment)
- **`.ply`**: PLY point cloud format
- **`.compressed.ply`**: Compressed PLY format
- **`.spz`**: Spark.js compressed format

### .splat Format Details

The `.splat` binary format structure:
- **Header**: Variable size (typically 8-1024 bytes)
- **Per-splat data**: 52 bytes
  - Position: 3 floats (12 bytes)
  - Color: 3 floats (12 bytes)
  - Scale: 3 floats (12 bytes)
  - Rotation: 4 floats (16 bytes, quaternion)

## Best Practices for Splat Preparation

### Origin and Positioning

- **Origin at Bottom**: Ensure the splat's origin (0,0,0) is positioned at the bottom of the model. This is crucial for proper placement in AR mode, as the viewer places splats on detected floor surfaces. Models with origins at the center or top may appear floating or buried in AR.
- **Y-Up Coordinate System**: The viewer uses a Y-up coordinate system (WebXR standard). Ensure your splat files follow this convention.
- **Reasonable Scale**: Keep model dimensions in a reasonable range (typically 0.1 to 10 meters) for best AR placement results.

### Splat Count Optimization

- **Target Count**: Aim for **100K to 500K Gaussians** for optimal performance on mobile devices. Models with more than 1 million Gaussians may experience performance degradation.
- **Quality vs. Performance**: Balance visual quality with performance. Higher splat counts provide better detail but require more GPU resources.

### File Format Conversion

The viewer works best with optimized formats. Here are recommended conversion workflows:

#### Using SuperSplat Editor (Web-based)

1. Visit [SuperSplat Editor](https://superspl.at/editor)
2. Upload your `.ply` file
3. Use the editor to:
   - Adjust origin and positioning
   - Preview and optimize the model
   - Export to desired format:
     - **`.splat`**: Standard binary format
     - **`.compressed.ply`**: Compressed PLY format

#### Using splat-transform CLI Tool

The [splat-transform](https://github.com/playcanvas/splat-transform) CLI tool provides powerful conversion and transformation capabilities.

**Installation:**
```bash
npm install -g @playcanvas/splat-transform
```

**Basic Conversions:**

```bash
# Convert PLY to SOG (recommended for web)
splat-transform input.ply output.sog

# Convert PLY to .splat format
splat-transform input.ply output.splat

# Convert PLY to compressed PLY
splat-transform input.ply output.compressed.ply

# Convert from .splat back to PLY
splat-transform input.splat output.ply
```

**With Transformations:**

```bash
# Adjust origin position (translate to place origin at bottom)
splat-transform input.ply -t 0,1,0 output.sog

# Scale model to reasonable size
splat-transform input.ply -s 0.1 output.sog

# Rotate model (if needed)
splat-transform input.ply -r 0,90,0 output.sog

# Chain multiple transformations
splat-transform input.ply -t 0,1,0 -s 0.5 -r 0,0,0 output.sog
```

**Advanced Options:**

```bash
# Filter out problematic Gaussians
splat-transform input.ply --filter-nan output.sog

# Reduce spherical harmonic bands (for smaller file size)
splat-transform input.ply --filter-harmonics 2 output.sog

# Generate HTML viewer directly
splat-transform input.ply output.html
```

**Recommended Workflow:**

1. **Prepare your PLY file** with proper origin positioning
2. **Convert to SOG format** for optimal web performance:
   ```bash
   splat-transform input.ply -s 0.1 -t 0,0,0 output.sog
   ```
3. **Test in the viewer** and adjust transforms via HTML attributes if needed
4. **Optimize further** if needed using filtering options

**Note**: The `.sog` format is recommended for web deployment as it provides the best compression ratio while maintaining visual quality. The `.compressed.ply` format is also a good alternative with broader compatibility.

## Security

- **Content Security Policy (CSP)**: Configured to block external connections, ensuring sandboxed deployment
- **Input Sanitization**: All URL parameters and attributes are sanitized
- **Path Traversal Prevention**: File paths are validated to prevent directory traversal attacks
- **XSS Protection**: CSP headers prevent inline script execution
- **Secure Context**: WebXR features require HTTPS or localhost

## Development

### Project Structure

```
00_production_Spark/
├── src/                    # Local dependencies (sandboxed)
│   ├── three/             # Three.js library and addons
│   └── spark/             # Spark.js library
├── index.html             # Example usage
├── splat-viewer.js        # Main viewer component
├── *.splat                # Splat files (place in root)
├── package.json           # NPM dependencies
└── README.md              # This file
```

### Dependencies

All external dependencies are bundled locally in the `src/` folder:

- **Three.js** (v0.178.0): `src/three/`
  - Main library: `three.module.js` + `three.core.js`
  - Addons: `addons/controls/` and `addons/webxr/`
- **Spark.js** (v0.1.10): `src/spark/`
  - Main library: `spark.module.js`

### Updating Dependencies

To update dependencies:

1. Update versions in `package.json`
2. Run `npm install` to update `node_modules/`
3. Copy updated files from `node_modules/` to `src/`:
   ```bash
   # Three.js
   cp node_modules/three/build/three.module.js src/three/
   cp node_modules/three/build/three.core.js src/three/
   cp node_modules/three/examples/jsm/controls/*.js src/three/addons/controls/
   cp node_modules/three/examples/jsm/webxr/*.js src/three/addons/webxr/
   
   # Spark.js
   cp node_modules/@sparkjsdev/spark/dist/spark.module.js src/spark/
   ```

### Local Development

1. Install dependencies: `npm install`
2. Serve files via HTTP (required for ES modules):
   ```bash
   # Using Python
   python -m http.server 8000
   
   # Using Node.js
   npx serve .
   
   # Using PHP
   php -S localhost:8000
   ```
3. Open `http://localhost:8000` in your browser

## Limitations

### Technical Limitations

- **File Size**: Large splat files (>1 million points) may experience performance degradation
- **WebXR Support**: AR functionality requires WebXR-capable browsers and devices, limiting availability on iOS devices
- **Hit-Testing**: Ground plane detection requires device support for spatial tracking; falls back to raycasting when unavailable
- **Coordinate System**: Uses Y-up coordinate system for WebXR compatibility

### Platform Limitations

- **iOS Support**: No AR support on iOS Safari due to lack of WebXR implementation (as of current iOS versions)
- **Desktop AR**: Limited AR support on desktop platforms; primarily designed for mobile AR experiences
- **Browser Requirements**: Requires modern browsers with WebGL 2.0 and ES6 module support
- **HTTPS Requirement**: WebXR features require secure context (HTTPS or localhost) for security reasons

## Troubleshooting

### AR Button Not Visible

- Ensure you're using a WebXR-compatible browser on Android
- Check that you're accessing via HTTPS or localhost
- Verify device has ARCore support (Android)
- Check that `enable-ar="true"` is set on the `<splat-viewer>` element

### Splat File Not Loading

- Verify file format is correct `.splat` binary format
- Check browser console for error messages
- Ensure file path in `splat-src` attribute is correct
- Verify file is accessible via web server (not `file://` protocol)

### Performance Issues

- Reduce splat file size or point count
- Use device with better GPU performance
- Close other applications to free memory
- Check browser console for WebGL errors

### AR Placement Not Working

- Ensure camera permissions are granted
- Check that hit-testing is supported (may fall back to raycasting)
- Verify device has spatial tracking capabilities
- Try moving the device to scan the environment first

### Dependencies Not Loading

- Verify `src/` folder contains all required files
- Check browser console for 404 errors
- Ensure import map in `index.html` points to correct paths
- Verify CSP allows loading from `src/` directory

## Credits

- **Spark.js**: [@sparkjsdev/spark](https://sparkjs.dev/) - Gaussian Splat rendering library
- **Three.js**: [threejs.org](https://threejs.org/) - 3D graphics library
- **model-viewer**: Inspired by Google's [`model-viewer`](https://modelviewer.dev/) component architecture and AR implementation
- **WebXR**: [immersiveweb.dev](https://immersiveweb.dev/) - WebXR standards and documentation

## License

MIT License

Copyright (c) 2024, tnmndr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

