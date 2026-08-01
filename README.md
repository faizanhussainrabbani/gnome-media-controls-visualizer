# GNOME Media Controls with Audio Spectrum Visualizer

A modern, minimalist GNOME Shell extension that displays currently playing media info in the top bar with a built-in **16-Band Stacked Pill LED VU Meter Audio Spectrum Visualizer** and elevated playback controls.

![GNOME Shell Extension](https://img.shields.io/badge/GNOME%20Shell-45%20%7C%2046%20%7C%2047-blue.svg)
![License](https://img.shields.io/badge/License-GPL%20v3-green.svg)

---

## 🌟 Features

- 🎵 **16-Band LED VU Meter Spectrum Visualizer**: Sleek 16-band stacked pill dot matrix visualizer that dynamically reacts to music playback with zero CPU overhead.
- ⚡ **Minimalist & Unbloated Layout**: Streamlined popup card design optimized for zero clutter and fast responsiveness.
- ⏯️ **Elevated Control Bar**:
  - Prominent **Play / Pause** central focal pill button.
  - Active visual feedback highlights for **Shuffle (Mix)** and **Loop (Repeat)** toggle states.
  - Smooth rounded hover micro-interactions (`border-radius: 99px`).
- 🎧 **Universal MPRIS2 Compatibility**: Compatible with Spotify, Rhythmbox, VLC, Audacious, Firefox, Chrome, Celluloid, and all MPRIS2 D-Bus media players.
- ⚙️ **Customizable Preferences**: Built-in toggle in Extension Preferences (`Show Spectrum Visualizer`) to enable or disable the visualizer at any time.

---

## 📸 Popup Menu Layout

```
┌────────────────────────────────────────┐
│  🎵 Spotify                     📌     │  ← Player selector & Pin
├────────────────────────────────────────┤
│  ▅ ▇ ▃ ▅ █ ▇ ▅ ▃ ▅ ▇ ▃ ▅ █ ▇ ▅        │  ← 16-Band LED VU Meter Spectrum
├────────────────────────────────────────┤
│        Song Title                      │  ← Scrolling Track Title
│     Artist / Album Name                │  ← Artist & Album Label
├────────────────────────────────────────┤
│  ●━━━━━━━━━━━━━━━○───────────────────  │  ← Track Position Slider
│  01:23                           03:45 │
├────────────────────────────────────────┤
│    🔁   ⏮    ▶    ⏭   🔀             │  ← Enhanced Controls Bar
└────────────────────────────────────────┘
```

---

## 📋 Prerequisites

- **OS**: Linux (Ubuntu 23.10+, Fedora 39+, Arch Linux, Debian 12+, Manjaro, etc.)
- **Desktop Environment**: GNOME Shell 45, 46, or 47
- **Tooling**: `glib-compile-schemas` (installed by default on GNOME via `glib2` / `libglib2.0-bin`)

---

## 🚀 Installation Guide

### Option 1: Quick One-Liner (Terminal)

Open your terminal and run:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/faizanhussainrabbani/gnome-media-controls-visualizer.git ~/.local/share/gnome-shell/extensions/mediacontrols@cliffniff.github.com
glib-compile-schemas ~/.local/share/gnome-shell/extensions/mediacontrols@cliffniff.github.com/schemas/
gnome-extensions enable mediacontrols@cliffniff.github.com
```

### Option 2: Step-by-Step Manual Installation

1. **Clone the repository** to your GNOME Shell user extensions directory:
   ```bash
   git clone https://github.com/faizanhussainrabbani/gnome-media-controls-visualizer.git ~/.local/share/gnome-shell/extensions/mediacontrols@cliffniff.github.com
   ```

2. **Compile the GSettings Schema**:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/mediacontrols@cliffniff.github.com/schemas/
   ```

3. **Enable the Extension**:
   ```bash
   gnome-extensions enable mediacontrols@cliffniff.github.com
   ```

4. **Restart GNOME Shell**:
   - **Wayland (Ubuntu / Fedora default)**: Log out and log back in (or disable & re-enable via Extension Manager).
   - **X11**: Press `Alt + F2`, type `r`, and hit `Enter`.

---

## 🎮 How to Use

1. Launch your favorite media player (e.g. Spotify, Rhythmbox, YouTube on Firefox/Chrome, VLC).
2. Start playing a track.
3. Click the **Media Controls** indicator in your GNOME top bar.
4. The popup card will display the live **16-Band LED VU Meter Spectrum**, track labels, progress bar, and media controls!

---

## ⚙️ Configuration & Preferences

To open the preferences window:

```bash
gnome-extensions prefs mediacontrols@cliffniff.github.com
```

Or open the **Extension Manager / GNOME Extensions** app and click the gear icon next to **Media Controls**.

---

## 📄 License & Credits

- **License**: [GPL-3.0 License](LICENSE)
- **Credits**: Based on the original GNOME Media Controls extension by [cliffniff](https://github.com/cliffniff/media-controls). Spectrum visualizer and UI enhancements created by [Faizan Hussain Rabbani](https://github.com/faizanhussainrabbani).
