import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Opt-in external-link consent, persisted independently of conversation data. */
export class ExternalLinkPreferences {
  constructor(path) {
    this.path = path;
    this.always = false;
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      this.always = value.alwaysOpen === true;
    } catch { this.always = false; }
  }

  async setAlways(value) {
    const always = value === true;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ alwaysOpen: always }, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
    this.always = always;
  }
}
