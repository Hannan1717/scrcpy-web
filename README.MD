# Scrcpy Web Project

This is a web project that allows you to control an Android device using **scrcpy** and **ADB** through a web interface. To run this application, you need to install some dependencies first.

## Prerequisites

Before running the application, ensure that you have the following installed:

### 1. Install **ADB**

**ADB** (Android Debug Bridge) is a tool used to communicate with your Android device from your computer.

-   For **Windows**: You can download ADB through the [SDK Platform Tools](https://developer.android.com/studio#downloads).
-   For **macOS/Linux**: ADB is often available via a package manager (e.g., `brew install android-platform-tools` on macOS).

After installation, make sure that ADB is accessible from the terminal or command prompt.

### 2. Install **scrcpy**

**scrcpy** is an application that allows you to display and control an Android device via USB (or Wi-Fi).

-   For **Windows**: You can download the prebuilt version of scrcpy from the [scrcpy GitHub releases](https://github.com/Genymobile/scrcpy/releases).
-   For **macOS**: You can install it via `brew`:
    ```bash
    brew install scrcpy
    ```
-   For **Linux**: You can install it using `apt` or another package manager:
    ```bash
    sudo apt install scrcpy
    ```

### 3. Connect Android Device

Connect your Android device to your computer using a USB cable and make sure USB Debugging is enabled on the Android device.

To enable USB Debugging:

-   Go to **Settings** → **About Phone** → Tap **Build Number** 7 times to enable **Developer Options**.
-   Go to **Settings** → **Developer Options** → Enable **USB Debugging**.

Check that your device is connected properly by running:

```bash
adb devices
```

### 4. Runnning the Application

```bash
npm install
nodemon serverUseHsl.js
```
