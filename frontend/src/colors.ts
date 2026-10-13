import type { Appearance, Host } from './types';

/** Colors a group can wear: a strip on its tabs and a dot in the sidebar. */
export const GROUP_COLORS: { id: string; label: string; css: string }[] = [
  { id: 'red', label: 'Red', css: '#ef4444' },
  { id: 'orange', label: 'Orange', css: '#f97316' },
  { id: 'yellow', label: 'Yellow', css: '#eab308' },
  { id: 'green', label: 'Green', css: '#22c55e' },
  { id: 'teal', label: 'Teal', css: '#14b8a6' },
  { id: 'blue', label: 'Blue', css: '#3b82f6' },
  { id: 'purple', label: 'Purple', css: '#a855f7' },
  { id: 'pink', label: 'Pink', css: '#ec4899' },
];

export const colorCss = (id?: string | null) => GROUP_COLORS.find((c) => c.id === id)?.css;

/** Keys in Appearance.groupColors: Remote Desktop groups by name, SSH groups by path. */
export const rdpGroupKey = (group: string) => 'rdp:' + (group.trim() || 'Ungrouped').toLowerCase();
export const sshGroupKey = (path: string) => 'ssh:' + path;

/** An SSH host takes the color of its group, or of the nearest parent group that has one. */
export function hostColor(h: Host, colors: Appearance['groupColors']): string | undefined {
  if (!colors) return undefined;
  const parts = (h.group || '').split('/').filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const c = colorCss(colors[sshGroupKey(parts.slice(0, i).join('/'))]);
    if (c) return c;
  }
  return undefined;
}
