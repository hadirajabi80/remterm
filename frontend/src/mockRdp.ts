import type { Machine, RdpCredential, RdpData } from './types';

/**
 * Browser-only fake of the RDP engine (RdpCall). There is no real session
 * window in a browser: sessions just report "connected" after a moment.
 */
export function createRdpMock(emit: (name: string, ...data: any[]) => void) {
  const id = () => Math.random().toString(16).slice(2, 10);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const base = { credentialId: null, autoType: 'auto' as const, favorite: false, lastUsed: null, notes: '', mode: 'bastion' as const };
  const machines: Machine[] = [
    { ...base, id: id(), name: 'NFCore', ip: '172.16.170.221', target: 'Interactive@NFCore-172.16.170.221:RDP', group: 'NF', favorite: true, lastUsed: ago(20) },
    { ...base, id: id(), name: 'NFGateway', ip: '172.16.170.230', target: 'Interactive@NFGateway-172.16.170.230:RDP', group: 'NF', lastUsed: ago(200) },
    { ...base, id: id(), name: 'IRPT-Report01', ip: '10.20.1.15', target: 'Interactive@IRPT-Report01-10.20.1.15:RDP', group: 'IRPT' },
    { ...base, id: id(), name: 'PTN-App', ip: '10.30.0.8', target: 'Interactive@PTN-App-10.30.0.8:RDP', group: 'PTN' },
    { ...base, id: id(), name: 'Lab PC', ip: '192.168.1.40', target: '', group: '', mode: 'direct' },
  ];
  const creds: (RdpCredential & { password: string })[] = [{ id: id(), name: 'Default', username: 'CORP\\hadi', hasPassword: true, password: 'x' }];
  const data: RdpData = {
    machines,
    credentials: creds,
    defaultCredentialId: creds[0].id,
    bastion: {
      host: '10.10.10.10',
      port: 3389,
      primaryUser: 'hadi',
      hasPassword: true,
      authorization: 'Sanay-Admins',
      loginTemplate: '{target}:{auth}:{user}',
      useNla: true,
      interactiveLoginUsesTarget: false,
      authLevel: 0,
    },
    settings: {
      autoTypeEnabled: true,
      autoFillOnConnect: false,
      autoTypeDelayMs: 1500,
      autoTypeSequence: '{login}{TAB}{password}{ENTER}',
      autoTypeDetectScreen: true,
      sessionUsesScreenSize: true,
      colorDepth: 32,
      smartSizing: true,
      dynamicResize: true,
      redirectClipboard: true,
      redirectDrives: false,
      playAudioLocally: true,
      windowsKeysToRemote: false,
      forceUsKeyboard: true,
      confirmCloseConnected: true,
      autoLockMinutes: 0,
      sidebarWidth: 290,
      diagEnabled: false,
      startFullscreen: false,
    },
    hasMaster: false,
    vaultPath: 'C:\\Users\\you\\AppData\\Roaming\\RemoteHub\\vault.dat',
    diagEnabled: false,
    ocr: true,
  };
  let locked = false;
  let classic = false;
  const status = () => ({ ready: true, locked, needsPassword: false, hasMaster: data.hasMaster, vaultPath: data.vaultPath, autoLockMinutes: 0 });
  const rx = /([^\s@]+@([^\s:@]+):RDP)/gi;

  const handlers: Record<string, (p: any) => unknown> = {
    status,
    unlock: () => ((locked = false), status()),
    lock: () => {
      if (!data.hasMaster) throw new Error('Set a master password first (Remote Desktop settings → Security).');
      locked = true;
      emit('rdp:event', 'locked', null);
      return status();
    },
    data: () => ({ ...data, credentials: creds.map(({ password: _, ...c }) => c) }),
    saveMachine: ({ machine }) => {
      const m = { ...machine, id: machine.id || id() } as Machine;
      const i = machines.findIndex((x) => x.id === m.id);
      if (i >= 0) machines[i] = m;
      else machines.push(m);
      return m;
    },
    deleteMachines: ({ ids }) => ids.forEach((d: string) => machines.splice(machines.findIndex((m) => m.id === d), 1)),
    renameGroup: ({ from, to }) => machines.forEach((m) => (m.group || 'Ungrouped') === from && (m.group = to)),
    saveCredential: ({ credential, password }) => {
      let c = creds.find((x) => x.id === credential.id);
      if (!c) {
        c = { ...credential, id: id(), hasPassword: false, password: '' } as RdpCredential & { password: string };
        creds.push(c);
      }
      Object.assign(c, { name: credential.name || credential.username, username: credential.username });
      if (password != null) Object.assign(c, { password, hasPassword: !!password });
      data.defaultCredentialId ??= c.id;
      return c;
    },
    deleteCredential: ({ id: cid }) => creds.splice(creds.findIndex((c) => c.id === cid), 1),
    setDefaultCredential: ({ id: cid }) => (data.defaultCredentialId = cid),
    saveBastion: ({ bastion, password }) => (data.bastion = { ...bastion, hasPassword: password != null ? !!password : data.bastion.hasPassword }),
    saveSettings: ({ settings }) => (data.settings = settings),
    importPreview: ({ text }) => {
      const found = [...(text as string).matchAll(rx)].map((m) => m[2]);
      return { count: found.length, duplicates: 0, skipped: 0, sample: found.slice(0, 6) };
    },
    import: ({ text }) => {
      const found = [...(text as string).matchAll(rx)];
      found.forEach((m) => machines.push({ ...base, id: id(), name: m[2], ip: '', target: m[1], group: 'Imported' }));
      return { imported: found.length };
    },
    setMasterPassword: ({ password }) => ((data.hasMaster = !!password), status()),
    openDiag: () => null,
    open: ({ id: sid, machineId }) => {
      const m = machines.find((x) => x.id === machineId);
      setTimeout(() => emit('rdp:event', 'session', { id: sid, title: m?.name ?? 'Remote Desktop', status: 'connected', message: '', mode: 'docked' }), 900);
      return { title: m?.name ?? 'Remote Desktop', tooltip: '', machineId: machineId ?? '' };
    },
    bounds: () => null,
    close: ({ id: sid }) => emit('rdp:event', 'closed', { id: sid }),
    reconnect: () => null,
    disconnect: ({ id: sid }) => emit('rdp:event', 'session', { id: sid, title: 'Remote Desktop', status: 'disconnected', message: 'You disconnected.', mode: 'docked' }),
    focus: () => null,
    fill: () => emit('rdp:event', 'notify', { text: 'Demo mode: no real session to fill.' }),
    fullscreen: () => null,
    popout: () => null,
    dock: () => null,
    snapshot: () => '',
    connectedCount: () => 0,
  };

  return {
    RdpAvailable: async () => true,
    RdpCall: async (method: string, params: string) => {
      const h = handlers[method];
      if (!h) throw new Error('unknown method ' + method);
      const r = h(JSON.parse(params || '{}'));
      if (method.startsWith('save') || method.startsWith('delete') || method === 'import' || method === 'renameGroup') emit('rdp:event', 'changed', null);
      return JSON.stringify(r ?? null);
    },
    ClassicMenu: async () => ({ supported: true, enabled: classic }),
    SetClassicMenu: async (on: boolean) => {
      classic = on;
    },
    RestartExplorer: async () => {},
  };
}
