# hfs-directory

A plugin for [Rejetto HFS](https://github.com/rejetto/hfs) that customizes folder icons in the web interface using Nautilus custom icons and `.directory` files.

## Overview

Hierarchy (first hit wins): **Nautilus export sidecar → Nautilus (`gio`) → `.directory` → default folder icon**.

This plugin allows you to customize the appearance of folders displayed in HFS frontend:

- **Nautilus custom icons** – set a custom icon on a folder in GNOME Files (Nautilus) and HFS shows exactly the same icon file (via `metadata::custom-icon` / `metadata::custom-icon-name`)
- **Use custom folder colors** by specifying a color name in `.directory` (e.g., `folder-green`, `folder-blue`)

- **Use custom folder colors** by specifying a color name (e.g., `folder-green`, `folder-blue`)
- **Use custom folder icons** by providing an absolute path to an image file (e.g., `/path/to/icon.ico`)
- **Use HFS system icons** by specifying a known icon name (e.g., `folder`, `file`, `search`)

### Nautilus custom icons

Right-click a folder in GNOME Files → Properties → click the folder icon → choose a custom image. The plugin reads the same setting via `gio info`:

- `metadata::custom-icon` (`file:///path/to/icon.png`) → served as-is, exactly the same file Nautilus shows
- `metadata::custom-icon-name` (e.g., `folder-music`) → resolved like a `.directory` `Icon=` value (`folder-*` gives a colored folder, otherwise a system icon name)

If no Nautilus icon is set (or the referenced file is missing/unreadable), the plugin falls back to `.directory`.

### Nautilus when HFS runs as another user (sidecar exporter)

GVFS metadata lives in the desktop user's store (`~/.local/share/gvfs-metadata`) and custom icon files often sit under a `0700 $HOME` — an HFS process running as e.g. `hfs` can see neither. For exact-icon parity in that setup, run the exporter as the desktop user:

```bash
./exporter/install.sh
```

It installs a systemd **user** timer (`hfs-directory-export.timer`, every 3 min) that scans `$HFS_EXPORT_ROOTS` (default `/mnt/GIT`, depth `$HFS_EXPORT_DEPTH`, default 4) with `gio info` and mirrors each custom icon byte-identically into the world-readable cache `$HFS_EXPORT_CACHE` (default `/var/tmp/hfs-directory`) plus a `manifest.json`. The plugin reads that manifest first — no root needed anywhere.

Env overrides: `HFS_EXPORT_ROOTS` (colon-separated), `HFS_EXPORT_DEPTH`, `HFS_EXPORT_CACHE`, `HFS_EXPORT_GIO_TIMEOUT`. The plugin side honors `HFS_DIRECTORY_CACHE` (same default) for the cache dir location.

### Required file permissions

HFS must be able to **read** the `.directory` files and any referenced icon files (it usually runs as another user). Dolphin/file managers often create them as `600`, which makes the plugin silently fall back to the default icon (a permission warning is logged once per path in the HFS log). Fix:

```bash
chmod 644 /path/to/folder/.directory
chmod 644 /path/to/icon.png   # if .directory points at a custom file
```

Parent directories need the traverse (`+x`) bit for others, which is the normal case.

## Syntax

The `.directory` file uses an INI-like format with a `[Desktop Entry]` section:

```ini
[Desktop Entry]
Icon=folder-green
```

or

```ini
[Desktop Entry]
Icon=/absolute/path/to/custom-icon.png
```

### Supported Icon Values

#### 1. Colored Folder Icons

Prefix `folder-` with a color name to colorize the standard folder icon:

```ini
[Desktop Entry]
Icon=folder-green
```

**Available colors:**
- `folder-green` – Green folder
- `folder-blue` – Blue folder
- `folder-red` – Red folder
- `folder-yellow` – Yellow folder
- `folder-orange` – Orange folder
- `folder-gray` – Gray folder
- `folder-violet` – Violet folder
- `folder-pink` – Pink folder
- `folder-cyan` – Cyan folder
- `folder-git` – Git-orange folder

#### 2. Custom Icon Files

Use an absolute path to serve a local image file as the folder icon. The file must exist and have one of these extensions:

- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.bmp`, `.avif`

Example:

```ini
[Desktop Entry]
Icon=/home/user/icons/my-folder-icon.png
```

**Security note:** Icons are served through a secure, tokenized route. File access is limited to image files only.

#### 3. System Icon Names

Use any known HFS system icon name (though typically you'd use folder-based colors instead):

```ini
[Desktop Entry]
Icon=folder
```

Common icon names: `folder`, `file`, `search`, `download`, `upload`, etc.

## How It Works

### Backend (plugin.js)

1. **Checks the Nautilus export sidecar first** – Reads `manifest.json` from the exporter cache (exact mirrored icon file, or theme name resolved like a `.directory` `Icon=`)
2. **Checks Nautilus directly** – Runs `gio info -a metadata::custom-icon,metadata::custom-icon-name` on the folder (covers setups where HFS runs as the desktop user)
3. **Reads `.directory` file** – When no Nautilus icon applies, looks for a `.directory` file in that folder
3. **Parses the INI content** – Extracts the `Icon` value from the `[Desktop Entry]` section
4. **Resolves the icon** – Based on the value:
   - If it's a `folder-*` name → sets icon to "folder" + color metadata
   - If it's an absolute path → validates and tokenizes it for secure serving
   - Otherwise → uses the value as a system icon name
4. **Caches the result** – Parsed values are cached per folder with a 30-second TTL to reduce I/O

### Frontend (main.js + style.css)

1. **Listens to `entryIcon` events** – The frontend event hook intercepts folder icon rendering
2. **File icons render as `<img>`** – Sidecar/absolute-path icons are real image elements with fixed height (HFS paints icon URLs as empty background spans, which can look like no icon) plus an error fallback to the default icon
3. **Applies color class** – If a color was set, wraps the icon with a CSS class
4. **Renders with style** – The stylesheet applies the appropriate color to the folder icon

> **Coexistence:** HFS renders the output of *every* `entryIcon` handler. If another plugin (e.g. `emulatorJS-plugin` game covers) also returns an icon for folders, you'll see two icons — that plugin must render nothing when it has no cover instead of duplicating the default icon.

## Installation

1. Download or clone this plugin into your HFS plugins folder:
   ```
   ~/.hfs/plugins/hfs-directory/
   ```

2. Restart HFS or reload the plugin from the admin panel

## Usage Example

Create a `.directory` file in any folder you want to customize:

```bash
# Example folder structure
my-project/
├── .directory
├── docs/
│   ├── .directory
│   └── README.md
├── images/
│   ├── .directory
│   └── photo.jpg
└── videos/
    ├── .directory
    └── video.mp4
```

**my-project/.directory:**
```ini
[Desktop Entry]
Icon=folder-blue
```

**my-project/docs/.directory:**
```ini
[Desktop Entry]
Icon=folder-green
```

**my-project/images/.directory:**
```ini
[Desktop Entry]
Icon=/usr/share/icons/images-folder.png
```

**my-project/videos/.directory:**
```ini
[Desktop Entry]
Icon=folder-violet
```

After creating these files, refresh the HFS web interface and the folders will display with their custom colors/icons.

## Features

- ✅ **Nautilus parity** – A custom folder icon set in Nautilus shows exactly the same image in HFS
- ✅ **No restart required** – Changes take effect immediately (within cache TTL)
- ✅ **Lightweight** – Uses in-memory cache to minimize disk reads
- ✅ **Secure** – Absolute icon paths are validated and served through a tokenized route
- ✅ **Graceful fallback** – If `.directory` is missing or invalid, the default folder icon is used
- ✅ **CSS-friendly** – Color classes are safe and don't interfere with other styles
- ✅ **INI standard** – Uses the familiar `.directory` format from file managers

## Security

### Icon Path Validation

When `Icon` points to an absolute path:

- The file must exist on the filesystem
- The file must have an allowed image extension (`.png`, `.jpg`, `.gif`, etc.)
- File access is provided through a secure, single-use token
- The token expires after 30 seconds

### No Directory Traversal

The plugin ensures that:

- Only absolute paths to actual files are served
- No relative paths like `../../etc/passwd` are allowed
- Only image files are served (no `.txt`, `.sh`, etc.)

## Performance

### Caching

- **TTL:** 30 seconds per folder
- **In-memory storage:** Parsed `.directory` results are cached
- **Auto-invalidation:** Cache expires automatically; no manual clearing needed
- **Token cache:** Icon tokens are also time-limited

### Scalability

Even with hundreds of folders, the plugin performs efficiently:

- First access: reads and parses `.directory`
- Subsequent accesses (within 30s): instant cache hit
- After TTL: refreshed on next list request

## Troubleshooting

### Icon doesn't appear

1. If you set the icon in Nautilus and HFS runs as another user: install `./exporter/install.sh` as the desktop user and check `/var/tmp/hfs-directory/manifest.json` contains the folder
2. If you set the icon in Nautilus (same user): verify `gio info -a metadata::custom-icon,metadata::custom-icon-name /path/to/folder` shows the value, that `gio` exists on the HFS host, and that the referenced image file exists and is readable (some filesystems like `tmpfs` don't support GVFS metadata)
3. Check the HFS log for `permission denied for HFS user` — `.directory`/icon files must be readable by the HFS user (`chmod 644`)
4. Verify the `.directory` file exists in the correct folder
2. Check that the `[Desktop Entry]` section is present
3. Ensure the `Icon=` line has no leading spaces
4. If using an absolute path, verify the file exists and is readable

### Icon shows default folder icon

This is the graceful fallback behavior. Possible causes:

- `.directory` file is missing or unparseable
- `Icon` value is empty or invalid
- Absolute icon path doesn't exist or isn't an allowed image type

Enable HFS logs to see error details.

### Colored folder icon not showing

1. Check that you're using the correct color name (e.g., `folder-green`, not just `green`)
2. Ensure the frontend CSS was loaded (check browser console for style.css)
3. Clear browser cache and refresh

## API Version

This plugin requires **HFS API version 12.97 or higher**.

Check your HFS version in the admin panel under "System" > "Version".

## License

[Same as HFS](https://github.com/rejetto/hfs)

## Contributing

Found a bug or have a feature request? Please open an issue on GitHub.

---

**Happy customizing! 🎨**
