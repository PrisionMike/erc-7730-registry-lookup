import clipboard from "clipboardy";

/**
 * Copy text to the system clipboard. Returns false when no clipboard backend
 * is available (e.g. headless Linux without xclip/wl-copy) instead of throwing.
 */
export async function copy(text: string): Promise<boolean> {
  try {
    await clipboard.write(text);
    return true;
  } catch {
    return false;
  }
}
