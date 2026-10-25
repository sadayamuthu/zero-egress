#!/bin/bash

# Exit on error
set -e

# Check platform
platform=$(uname)

if [[ "$platform" == "Darwin" ]]; then
    echo "Running on macOS. Note that the AppImage created will only work on Linux systems."
    if ! command -v docker &> /dev/null; then
        echo "Docker Desktop for Mac is not installed. Please install it from https://www.docker.com/products/docker-desktop"
        exit 1
    fi
elif [[ "$platform" == "Linux" ]]; then
    echo "Running on Linux. Proceeding with AppImage creation..."
else
    echo "This script is intended to run on macOS or Linux. Current platform: $platform"
    exit 1
fi

# Enable BuildKit
export DOCKER_BUILDKIT=1

BUILD_IMAGE_NAME="zero-egress-appimage-builder"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Please start Docker first."
    exit 1
fi

# Check and install Buildx if needed
if ! docker buildx version >/dev/null 2>&1; then
    echo "Installing Docker Buildx..."
    mkdir -p ~/.docker/cli-plugins/
    curl -SL https://github.com/docker/buildx/releases/download/v0.13.1/buildx-v0.13.1.linux-amd64 -o ~/.docker/cli-plugins/docker-buildx
    chmod +x ~/.docker/cli-plugins/docker-buildx
fi

# Download appimagetool if not present
if [ ! -f "appimagetool" ]; then
    echo "Downloading appimagetool..."
    wget -O appimagetool "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool
fi

# Delete any existing AppImage to avoid bloating the build
rm -f ZeroEgress-x86_64.AppImage

# Create build Dockerfile
echo "Creating build Dockerfile..."
cat > Dockerfile.build << 'EOF'
# syntax=docker/dockerfile:1
FROM ubuntu:20.04

# Install required dependencies
RUN apt-get update && apt-get install -y \
    libfuse2 \
    libglib2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libasound2 \
    libdrm2 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EOF

# Create .dockerignore file
echo "Creating .dockerignore file..."
cat > .dockerignore << EOF
Dockerfile.build
.dockerignore
.git
.gitignore
.DS_Store
*~
*.swp
*.swo
*.tmp
*.bak
*.log
*.err
node_modules/
venv/
*.egg-info/
*.tox/
dist/
EOF

# Build Docker image without cache
echo "Building Docker image (no cache)..."
docker build --no-cache -t "$BUILD_IMAGE_NAME" -f Dockerfile.build .

# Create AppImage using local appimagetool
echo "Creating AppImage..."
docker run --rm --privileged -v "$(pwd):/app" "$BUILD_IMAGE_NAME" bash -c '
cd /app && \
rm -rf ZeroEgress.AppDir && \
mkdir -p ZeroEgress.AppDir/usr/bin ZeroEgress.AppDir/usr/lib ZeroEgress.AppDir/usr/share/applications && \
find . -maxdepth 1 ! -name ZeroEgress.AppDir ! -name "." ! -name ".." -exec cp -r {} ZeroEgress.AppDir/usr/bin/ \; && \
cp zero-egress.png ZeroEgress.AppDir/zero-egress.png && \
echo "[Desktop Entry]" > ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name=ZeroEgress" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Comment=Open source AI code editor." >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "GenericName=Text Editor" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Exec=zero-egress %F" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Icon=zero-egress" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Type=Application" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "StartupNotify=false" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "StartupWMClass=ZeroEgress" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Categories=TextEditor;Development;IDE;" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "MimeType=application/x-zero-egress-workspace;" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Keywords=zero-egress;" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Actions=new-empty-window;" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "[Desktop Action new-empty-window]" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name=New Empty Window" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[de]=Neues leeres Fenster" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[es]=Nueva ventana vacía" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[fr]=Nouvelle fenêtre vide" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[it]=Nuova finestra vuota" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[ja]=新しい空のウィンドウ" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[ko]=새 빈 창" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[ru]=Новое пустое окно" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[zh_CN]=新建空窗口" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Name[zh_TW]=開新空視窗" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Exec=zero-egress --new-window %F" >> ZeroEgress.AppDir/zero-egress.desktop && \
echo "Icon=zero-egress" >> ZeroEgress.AppDir/zero-egress.desktop && \
chmod +x ZeroEgress.AppDir/zero-egress.desktop && \
cp ZeroEgress.AppDir/zero-egress.desktop ZeroEgress.AppDir/usr/share/applications/ && \
echo "[Desktop Entry]" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Name=ZeroEgress - URL Handler" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Comment=Open source AI code editor." > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "GenericName=Text Editor" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Exec=zero-egress --open-url %U" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Icon=zero-egress" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Type=Application" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "NoDisplay=true" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "StartupNotify=true" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Categories=Utility;TextEditor;Development;IDE;" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "MimeType=x-scheme-handler/zero-egress;" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
echo "Keywords=zero-egress;" > ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
chmod +x ZeroEgress.AppDir/zero-egress-url-handler.desktop && \
cp ZeroEgress.AppDir/zero-egress-url-handler.desktop ZeroEgress.AppDir/usr/share/applications/ && \
echo "#!/bin/bash" > ZeroEgress.AppDir/AppRun && \
echo "HERE=\$(dirname \"\$(readlink -f \"\${0}\")\")" >> ZeroEgress.AppDir/AppRun && \
echo "export PATH=\${HERE}/usr/bin:\${PATH}" >> ZeroEgress.AppDir/AppRun && \
echo "export LD_LIBRARY_PATH=\${HERE}/usr/lib:\${LD_LIBRARY_PATH}" >> ZeroEgress.AppDir/AppRun && \
echo "exec \${HERE}/usr/bin/zero-egress --no-sandbox \"\$@\"" >> ZeroEgress.AppDir/AppRun && \
chmod +x ZeroEgress.AppDir/AppRun && \
chmod -R 755 ZeroEgress.AppDir && \

# Strip unneeded symbols from the binary to reduce size
strip --strip-unneeded ZeroEgress.AppDir/usr/bin/zero-egress

ls -la ZeroEgress.AppDir/ && \
ARCH=x86_64 ./appimagetool -n ZeroEgress.AppDir ZeroEgress-x86_64.AppImage
'

# Clean up
rm -rf ZeroEgress.AppDir .dockerignore appimagetool

echo "AppImage creation complete! Your AppImage is: ZeroEgress-x86_64.AppImage"
