"use strict";

/**
 * Frontend glue for hfs-directory.
 * File-based icons (Nautilus sidecar / absolute-path .directory) render as a
 * real <img> with an error fallback, and folder-* values wrap the default
 * glyph with a color class.
 */
{
    /**
     * Restrict class suffix to safe chars.
     * @param {string} value
     * @returns {string}
     */
    function sanitize(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    }

    /**
     * Detect icon values that point at a served file rather than a glyph name.
     * @param {unknown} value
     * @returns {boolean}
     */
    function isFileIconUrl(value) {
        if (typeof value !== "string" || !value) return false;
        return value[0] === "/" || value.includes("://");
    }

    function CustomIcon({ src, def }) {
        const [failed, setFailed] = HFS.React.useState(false);
        if (failed) return def || null;
        return HFS.h("img", {
            src,
            className: "icon hfs-directory-custom-icon",
            loading: "lazy",
            alt: "",
            draggable: false,
            onError() {
                setFailed(true);
            },
        });
    }

    HFS.onEvent("entryIcon", ({ entry, def }) => {
        if (isFileIconUrl(entry?.icon)) {
            return HFS.h(CustomIcon, { src: entry.icon, def });
        }

        const color = sanitize(entry?.hfsDirectoryColor);
        if (!color) return;

        return HFS.h(
            "span",
            { className: `hfs-directory-folder-icon hfs-directory-color-${color}` },
            def,
        );
    });
}
