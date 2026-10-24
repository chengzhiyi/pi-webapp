/** Must evaluate before the editor registers its FontFace sources. Keep this a separate import. */
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${location.origin}/assets/excalidraw/`;
