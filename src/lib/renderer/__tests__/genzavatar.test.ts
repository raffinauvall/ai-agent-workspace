import { describe, expect, it } from "vitest";
import { avatarStyle } from "../GenZAvatar";
import avatarData from "../assets/gen-z-avatar.glb?inline";

describe("original Gen Z avatar", () => {
  it("keeps rig, clips and material variations inside the mobile budget", () => {
    const glb = Uint8Array.from(atob(avatarData.slice(avatarData.indexOf(',') + 1)), char => char.charCodeAt(0));
    const view = new DataView(glb.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(glb.length).toBeLessThan(500 * 1024);
    const data = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
    expect(data.skins[0].joints).toHaveLength(15);
    expect(data.animations.map((a: { name: string }) => a.name).sort()).toEqual(["idle", "repair", "sit", "smoke", "walk", "work"]);
    expect(data.images).toBeUndefined(); // No texture fetch can break the local WebView.
    const triangles = data.meshes.flatMap((m: { primitives: { indices?: number; attributes: { POSITION: number } }[] }) => m.primitives)
      .reduce((sum: number, p: { indices?: number; attributes: { POSITION: number } }) => sum + data.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0);
    expect(triangles).toBeLessThan(8000);
    const ids = Array.from({length: 64}, (_, i) => `agent-${i}`);
    const styles = ids.map(avatarStyle);
    expect(new Set(styles.map(s => s.style)).size).toBe(6);
    expect(ids.reverse().map(avatarStyle)).toEqual(styles.reverse());
  });
});
