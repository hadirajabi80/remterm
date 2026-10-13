import type { ITheme } from '@xterm/xterm';
import type { Appearance } from './types';

// ---------------- color schemes ----------------

export interface Scheme {
  id: string;
  name: string;
  theme: ITheme & { background: string; foreground: string };
}

const s = (
  id: string,
  name: string,
  bg: string,
  fg: string,
  cursor: string,
  selection: string,
  normal: string[],
  bright: string[],
): Scheme => ({
  id,
  name,
  theme: {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: selection,
    black: normal[0],
    red: normal[1],
    green: normal[2],
    yellow: normal[3],
    blue: normal[4],
    magenta: normal[5],
    cyan: normal[6],
    white: normal[7],
    brightBlack: bright[0],
    brightRed: bright[1],
    brightGreen: bright[2],
    brightYellow: bright[3],
    brightBlue: bright[4],
    brightMagenta: bright[5],
    brightCyan: bright[6],
    brightWhite: bright[7],
  },
});

export const SCHEMES: Scheme[] = [
  s('tokyo', 'Tokyo Night', '#0d1117', '#d6dde6', '#7aa2f7', '#2b3f6b',
    ['#1b2029', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
    ['#565f89', '#ff899d', '#b9f27c', '#ffc777', '#8db0ff', '#c7a9ff', '#a4daff', '#e6ebff']),
  s('dracula', 'Dracula', '#282a36', '#f8f8f2', '#f8f8f2', '#44475a',
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  s('onedark', 'One Dark', '#282c34', '#abb2bf', '#528bff', '#3e4451',
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  s('catppuccin', 'Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#f5e0dc', '#45475a',
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  s('nord', 'Nord', '#2e3440', '#d8dee9', '#d8dee9', '#434c5e',
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  s('github', 'GitHub Dark', '#0d1117', '#c9d1d9', '#58a6ff', '#1f3b5c',
    ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'],
    ['#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc']),
  s('gruvbox', 'Gruvbox Dark', '#282828', '#ebdbb2', '#ebdbb2', '#504945',
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  s('solarized', 'Solarized Dark', '#002b36', '#839496', '#93a1a1', '#073642',
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#93a1a1', '#fdf6e3']),
  s('campbell', 'Campbell (Windows)', '#0c0c0c', '#cccccc', '#ffffff', '#3a3a3a',
    ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc'],
    ['#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2']),
  s('githublight', 'GitHub Light', '#ffffff', '#24292f', '#0969da', '#b6d7ff',
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
];

export function getScheme(id: string): Scheme {
  return SCHEMES.find((x) => x.id === id) ?? SCHEMES[0];
}

// ---------------- backgrounds ----------------

export interface Background {
  id: string;
  name: string;
  css: string; // CSS `background` shorthand
}

/** Deterministic PRNG so generated scenes look the same every launch. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const svgBg = (svg: string, position = 'center') =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${position} / cover no-repeat`;

const W = 1600;
const H = 900;

function stars(seed: number, count: number, maxY: number, maxR = 1.4): string {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const rad = (0.3 + r() * maxR).toFixed(2);
    out += `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * maxY).toFixed(0)}" r="${rad}" fill="#fff" opacity="${(0.25 + r() * 0.65).toFixed(2)}"/>`;
  }
  return out;
}

/** Mountain ridge by midpoint displacement. */
function ridge(seed: number, base: number, rough: number, fill: string): string {
  const r = rng(seed);
  let pts = [base + (r() - 0.5) * rough, base + (r() - 0.5) * rough];
  let disp = rough;
  for (let k = 0; k < 7; k++) {
    const next: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) next.push(pts[i], (pts[i] + pts[i + 1]) / 2 + (r() - 0.5) * disp);
    next.push(pts[pts.length - 1]);
    pts = next;
    disp *= 0.56;
  }
  const step = W / (pts.length - 1);
  const d = pts.map((y, i) => `L${(i * step).toFixed(1)} ${y.toFixed(1)}`).join('');
  return `<path d="M0 ${H}${d}L${W} ${H}Z" fill="${fill}"/>`;
}

function mountains(): string {
  return svgBg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#070a1c"/><stop offset=".55" stop-color="#1c1840"/><stop offset="1" stop-color="#4a2c5e"/>
        </linearGradient>
        <radialGradient id="moon" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#fff5e0" stop-opacity=".9"/><stop offset=".25" stop-color="#ffd9a8" stop-opacity=".35"/><stop offset="1" stop-color="#ffd9a8" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>
      ${stars(7, 160, 520)}
      <circle cx="1170" cy="250" r="150" fill="url(#moon)"/>
      <circle cx="1170" cy="250" r="34" fill="#fff4dc" opacity=".92"/>
      ${ridge(11, 470, 260, '#2c2550')}
      ${ridge(23, 590, 220, '#1d1938')}
      ${ridge(37, 710, 170, '#120f24')}
      ${ridge(41, 820, 90, '#0a0815')}
    </svg>`,
    'center bottom',
  );
}

function synthwave(): string {
  const horizon = 560;
  let grid = '';
  for (let i = 1; i <= 14; i++) {
    const y = horizon + Math.pow(i / 14, 2.2) * (H - horizon);
    grid += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`;
  }
  for (let i = -16; i <= 16; i++) {
    grid += `<line x1="${W / 2}" y1="${horizon}" x2="${W / 2 + i * 160}" y2="${H}"/>`;
  }
  let stripes = '';
  for (let i = 0; i < 7; i++) {
    const y = 420 + i * 22;
    stripes += `<rect x="560" y="${y}" width="480" height="${3 + i * 1.6}" fill="#1a0630"/>`;
  }
  return svgBg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#05010f"/><stop offset=".45" stop-color="#1a0630"/><stop offset=".62" stop-color="#4a0f4f"/>
        </linearGradient>
        <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffd166"/><stop offset=".55" stop-color="#ff5d8f"/><stop offset="1" stop-color="#b5179e"/>
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#22073a"/><stop offset="1" stop-color="#07010f"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>
      ${stars(3, 90, 420, 1)}
      <circle cx="${W / 2}" cy="430" r="190" fill="url(#sun)"/>
      ${stripes}
      <rect y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#floor)"/>
      <g stroke="#ff3fa4" stroke-opacity=".55" stroke-width="2">${grid}</g>
      <rect y="${horizon - 2}" width="${W}" height="3" fill="#ff7ac6" opacity=".7"/>
    </svg>`,
  );
}

function waves(): string {
  const layer = (base: number, amp: number, freq: number, phase: number, fill: string) => {
    let d = `M0 ${H}`;
    for (let x = 0; x <= W; x += 20) {
      const y = base + amp * Math.sin(x * freq + phase) + amp * 0.4 * Math.sin(x * freq * 2.3 + phase * 1.7);
      d += `L${x} ${y.toFixed(1)}`;
    }
    return `<path d="${d}L${W} ${H}Z" fill="${fill}"/>`;
  };
  return svgBg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#03101c"/><stop offset="1" stop-color="#062338"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      ${layer(430, 38, 0.004, 0.5, '#0a3150')}
      ${layer(520, 44, 0.0034, 2.1, '#0b3d5c')}
      ${layer(620, 40, 0.0042, 4.0, '#0d4a68')}
      ${layer(720, 34, 0.005, 1.2, '#0b5871')}
      ${layer(810, 26, 0.006, 3.3, '#0a6578')}
    </svg>`,
    'center bottom',
  );
}

function starfield(): string {
  return svgBg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="glow1" cx=".3" cy=".4" r=".5"><stop offset="0" stop-color="#5b3ea8" stop-opacity=".45"/><stop offset="1" stop-color="#5b3ea8" stop-opacity="0"/></radialGradient>
        <radialGradient id="glow2" cx=".75" cy=".65" r=".45"><stop offset="0" stop-color="#1f6fb2" stop-opacity=".4"/><stop offset="1" stop-color="#1f6fb2" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="#04050b"/>
      <rect width="${W}" height="${H}" fill="url(#glow1)"/>
      <rect width="${W}" height="${H}" fill="url(#glow2)"/>
      ${stars(19, 380, H, 1.6)}
    </svg>`,
  );
}

export const BACKGROUNDS: Background[] = [
  { id: 'none', name: 'None', css: '' },
  {
    id: 'midnight',
    name: 'Midnight',
    css: 'radial-gradient(ellipse at 15% 0%, #1f2b5e 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, #3b1c5e 0%, transparent 50%), #0a0d18',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    css: 'radial-gradient(ellipse 60% 50% at 15% 20%, rgba(52,211,153,.32), transparent 70%), radial-gradient(ellipse 50% 60% at 85% 25%, rgba(99,102,241,.38), transparent 70%), radial-gradient(ellipse 70% 50% at 50% 100%, rgba(168,85,247,.32), transparent 70%), #060a13',
  },
  { id: 'mountains', name: 'Mountains', css: mountains() },
  { id: 'synthwave', name: 'Synthwave', css: synthwave() },
  { id: 'waves', name: 'Deep Sea', css: waves() },
  { id: 'starfield', name: 'Starfield', css: starfield() },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(160deg, #160d2e 0%, #36123d 45%, #642136 75%, #9a4430 100%)' },
  {
    id: 'forest',
    name: 'Forest',
    css: 'radial-gradient(ellipse at 30% 110%, #1f5a3f 0%, transparent 60%), radial-gradient(ellipse at 90% -10%, #16343f 0%, transparent 55%), linear-gradient(180deg, #07120d, #0c2118)',
  },
  {
    id: 'dots',
    name: 'Dots',
    css: 'radial-gradient(rgba(122,162,247,.22) 1.2px, transparent 1.6px) 0 0 / 22px 22px, linear-gradient(180deg, #0a0e16, #111624)',
  },
  {
    id: 'carbon',
    name: 'Carbon',
    css: 'repeating-linear-gradient(45deg, rgba(255,255,255,.03) 0 2px, transparent 2px 9px), radial-gradient(ellipse at 50% 0%, #1a1f2b, #0b0d12 70%)',
  },
];

export function backgroundCss(a: Appearance): string {
  if (a.background === 'custom') return a.customImage ? `url("${a.customImage}") center / cover no-repeat` : '';
  return BACKGROUNDS.find((b) => b.id === a.background)?.css ?? '';
}

export const DEFAULT_APPEARANCE: Appearance = {
  scheme: 'tokyo',
  background: 'none',
  customImage: '',
  dim: 45,
  blur: 0,
  fontSize: 14,
  ui: 'dark',
};

/** Downscales a picked image so it fits comfortably in the settings file. */
export function loadImageFile(file: File, maxW = 2560): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}
