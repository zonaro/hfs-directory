"use strict";

/**
 * Frontend glue for hfs-directory.
 * Applies color classes for folder-* values parsed in backend.
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

    HFS.onEvent("entryIcon", ({ entry, def }) => {
        const color = sanitize(entry?.hfsDirectoryColor);
        if (!color) return;

        return HFS.h(
            "span",
            { className: `hfs-directory-folder-icon hfs-directory-color-${color}` },
            def,
        );
    });
}
