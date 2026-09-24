/**
 * Chequeo del acceso remoto (hito 37, §14).
 *
 *   npx tsx scripts/check-remote-access.mjs
 *
 * Lo que se rompe en silencio, y acá es seguridad: un código para emparejar que
 * sirve dos veces o que no muere a los cinco intentos, una credencial revocada
 * que sigue entrando, un equipo remoto que puede fabricar más equipos o abrir
 * un programa en el escritorio del anfitrión, y —lo más fácil de romper sin
 * verlo— que con el acceso **apagado** algo de todo esto se acepte igual.
 *
 * Y de la interfaz, lo que no tiene JSX: el comando del túnel y la dirección
 * para emparejar —los copia el usuario a otro equipo, y un puerto distinto en
 * cada extremo es un 403 sin explicación—, y cuándo sale una notificación del
 * sistema (§6.20.1).
 *
 * Desde el hito 38, el teléfono (§15): la llave que viaja en el QR —que la
 * pública sea la de esa semilla, que la línea que se pega la restrinja al
 * túnel y no deje ejecutar nada, que el QR no lleve nada de más— y que sólo la
 * pida y la vea una ventana del anfitrión.
 *
 * Nunca toca la carpeta de configuración real: los ajustes y los equipos van a
 * una carpeta temporal del chequeo. No abre ningún puerto ni carga node-pty.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PAIR_QUERY_PARAM,
  REMOTE_DEFAULT_PORT,
  REMOTE_DEVICE_LABEL_MAX_CHARS,
  ServerTextError,
  TOKEN_QUERY_PARAM,
  parseClientMessage,
  parseServerMessage,
} from '@agent-workbench/shared';
import {
  DeviceBook,
  PAIRING_ALPHABET,
  PAIRING_CODE_CHARS,
  PAIRING_MAX_FAILURES,
  PairingDesk,
  REMOTE_MAX_DEVICES,
  deviceLabelFromUserAgent,
  formatPairingCode,
  normalizePairingCode,
  parseRemoteDevicesFile,
  privateIpv4Addresses,
  remoteAccessState,
  remoteRefusal,
  serializeRemoteDevices,
} from '../src/remote-access.ts';
import { RemoteAccessService } from '../src/remote-access-service.ts';
import { RemoteDevicesStore } from '../src/remote-devices-store.ts';
import {
  DEVICE_COOKIE,
  TOKEN_COOKIE,
  TOKEN_HEADER,
  authorizeRequest,
  buildDeviceCookie,
  matchCredential,
  readPairingCode,
} from '../src/security.ts';
import { SettingsStore, parseAppSettings } from '../src/settings-store.ts';
import {
  PHONE_KEY_COMMENT,
  PHONE_PAYLOAD_PREFIX,
  authorizeShellFromGroups,
  ed25519PublicKey,
  parsePhonePairingPayload,
  phoneAuthorizeCommand,
  phoneAuthorizedKeysEntry,
  phonePairingPayload,
  sshEd25519PublicKey,
} from '../src/phone-pairing.ts';
import { qrMatrix, qrModuleDark } from '../../web/src/qr-code.ts';
import { remoteAccessStartupLine } from '../src/startup-summary.ts';
import { setLocale } from '../../web/src/i18n/index.ts';
import {
  canPair,
  defaultHostName,
  deviceSeenText,
  formatCountdown,
  pairingSecondsLeft,
  pairingUrl,
  parsePortInput,
  remoteStateText,
  phoneAuthorizeText,
  remoteUrl,
  sshTunnelCommand,
} from '../../web/src/remote-access-ui.ts';
import {
  notificationBody,
  notifyButtonTitle,
  parseStoredNotify,
  shouldNotify,
  tabNameFor,
} from '../../web/src/system-notification.ts';

// Los textos de la interfaz salen de `t()` (§6.23): se comparan con el español.
await setLocale('es');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

const workDir = await mkdtemp(path.join(os.tmpdir(), 'aw-check-remote-'));

/** Un reloj que se adelanta a mano. */
const fakeClock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};

/** Bytes previsibles: cada pedido devuelve un relleno distinto. */
const fakeRandom = () => {
  let turn = 0;
  return (size) => {
    turn += 1;
    return Buffer.alloc(size, turn);
  };
};

const request = ({ url = '/', host = `127.0.0.1:${REMOTE_DEFAULT_PORT}`, origin, cookie, header } = {}) => {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (cookie !== undefined) headers.cookie = cookie;
  if (header !== undefined) headers[TOKEN_HEADER] = header;
  return { url, headers };
};

try {
  // --- 1. El código para emparejar ---------------------------------------------
  {
    check('el alfabeto no tiene letras confundibles y es de 32',
      PAIRING_ALPHABET.length === 32 && !/[01IO]/.test(PAIRING_ALPHABET) && new Set(PAIRING_ALPHABET).size === 32);
    check('el código tiene 8 caracteres: unos 40 bits', PAIRING_CODE_CHARS === 8);
    check('se muestra con un guion en el medio', formatPairingCode('K7QMX2RD') === 'K7QM-X2RD');
    check('se acepta en minúsculas, con guion o con espacios',
      normalizePairingCode(' k7qm-x2rd ') === 'K7QMX2RD' && normalizePairingCode('K7QM X2RD') === 'K7QMX2RD');
    check('uno corto, largo o con otra letra no es un código',
      normalizePairingCode('K7QM') === null && normalizePairingCode('K7QMX2RDA') === null &&
      normalizePairingCode('K7QM-X2R0') === null && normalizePairingCode('') === null);

    const clock = fakeClock();
    const desk = new PairingDesk({ now: clock.now, randomBytes: fakeRandom() });
    check('sin código vigente no se compara nada', desk.redeem('AAAA-AAAA') === 'none' && !desk.isActive());

    const first = desk.start();
    check('el código sale con su forma y su vencimiento',
      /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(first.code) && first.expiresAt === clock.now() + 5 * 60_000, json(first));
    check('el bueno entra', desk.redeem(first.code.toLowerCase()) === 'ok');
    check('y sirve una sola vez', desk.redeem(first.code) === 'none' && !desk.isActive());

    const second = desk.start();
    clock.advance(5 * 60_000 + 1);
    check('vencido no entra, y deja de estar vigente', desk.redeem(second.code) === 'none' && !desk.isActive());

    const third = desk.start();
    const wrong = third.code.startsWith('A') ? 'BBBB-BBBB' : 'AAAA-AAAA';
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++) desk.redeem(wrong);
    check('cuatro fallos todavía lo dejan vivo', desk.isActive() && desk.redeem(third.code) === 'ok');

    const fourth = desk.start();
    const outcomes = [];
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++) outcomes.push(desk.redeem(wrong));
    check('a los cinco fallos el código muere',
      outcomes.every((o) => o === 'wrong') && !desk.isActive() && desk.redeem(fourth.code) === 'none', json(outcomes));

    const fifth = desk.start();
    const sixth = desk.start();
    check('pedir otro reemplaza al anterior', fifth.code !== sixth.code && desk.redeem(fifth.code) === 'wrong' && desk.redeem(sixth.code) === 'ok');

    desk.start();
    desk.cancel();
    check('cancelarlo lo apaga', !desk.isActive());
    check('algo que no es un código no cuenta como intento',
      (() => { const c = desk.start(); for (let i = 0; i < 20; i++) desk.redeem('hola'); return desk.redeem(c.code) === 'ok'; })());
  }

  // --- 2. El libro de equipos --------------------------------------------------
  {
    const clock = fakeClock();
    let nextId = 0;
    const book = new DeviceBook({ now: clock.now, randomBytes: fakeRandom(), randomId: () => `dev-${++nextId}` });
    const enrolled = book.enroll('  Chrome ·   Windows  ');
    check('emparejar devuelve la credencial y un equipo con nombre limpio',
      enrolled !== null && enrolled.credential.length >= 43 && enrolled.device.label === 'Chrome · Windows', json(enrolled?.device));

    const saved = serializeRemoteDevices(book.snapshot());
    check('en disco va el hash, nunca la credencial',
      !saved.includes(enrolled.credential) && /"hash": "[0-9a-f]{64}"/.test(saved));
    check('la credencial buena encuentra su equipo', book.match(enrolled.credential)?.id === 'dev-1');
    check('otra no encuentra nada', book.match('x'.repeat(43)) === null && book.match('') === null);

    clock.advance(5_000);
    check('la última vez visto se anota', book.touch('dev-1') && book.list()[0].lastSeenAt === clock.now());
    check('renombrar limpia y acota', book.rename('dev-1', 'a'.repeat(200)) &&
      book.list()[0].label.length === REMOTE_DEVICE_LABEL_MAX_CHARS);
    check('un nombre vacío no se acepta', !book.rename('dev-1', '   '));
    check('lo que se lista no trae hash', !json(book.list()).includes('hash'));

    const round = parseRemoteDevicesFile(JSON.parse(saved));
    check('lo guardado se vuelve a leer igual', json(round) === json(JSON.parse(saved).devices));
    check('otra versión del archivo no se lee', parseRemoteDevicesFile({ version: 99, devices: [] }) === null);
    check('una entrada rota no se lleva a las demás',
      parseRemoteDevicesFile({ version: 1, devices: [{ id: 'x' }, JSON.parse(saved).devices[0]] })?.length === 1);
    check('un hash que no es un sha256 se descarta',
      parseRemoteDevicesFile({ version: 1, devices: [{ ...JSON.parse(saved).devices[0], hash: 'abc' }] })?.length === 0);

    check('revocar lo saca', book.revoke('dev-1') && book.match(enrolled.credential) === null && book.list().length === 0);
    check('revocar uno que no está dice false', !book.revoke('dev-1'));

    for (let i = 0; i < REMOTE_MAX_DEVICES; i++) book.enroll(`equipo ${i}`);
    check('hay un tope de equipos', book.enroll('uno más') === null && book.list().length === REMOTE_MAX_DEVICES);
  }

  // --- 3. El archivo de equipos ------------------------------------------------
  {
    const file = path.join(workDir, 'devices', 'remote-devices.json');
    const warnings = [];
    const store = new RemoteDevicesStore(file, { warn: (message) => warnings.push(message) });
    check('sin archivo no hay equipos', json(await store.load()) === '[]');
    check('y leer no lo crea', await stat(file).then(() => false, () => true));

    const book = new DeviceBook({ now: () => 5, randomBytes: fakeRandom(), randomId: () => 'dev-a' });
    const { credential } = book.enroll('Portátil');
    await store.save(book.snapshot());
    const text = await readFile(file, 'utf8');
    check('guardar escribe el archivo, sin la credencial', text.includes('dev-a') && !text.includes(credential));
    if (process.platform !== 'win32') {
      const mode = (await stat(file)).mode & 0o777;
      check('con permisos sólo del usuario', mode === 0o600, mode.toString(8));
    }
    check('y se vuelve a leer', json(await store.load()) === json(book.snapshot()));

    await writeFile(file, '{esto no es json');
    check('un archivo roto da una lista vacía y avisa', json(await store.load()) === '[]' && warnings.length === 1, json(warnings));
    check('y no se toca: leer nunca escribe', (await readFile(file, 'utf8')) === '{esto no es json');
  }

  // --- 4. Los ajustes ------------------------------------------------------------
  {
    const today = { version: 1, vault: { enabled: true, dir: null, toolResultMaxChars: 64000 } };
    const parsed = parseAppSettings(today, process.platform);
    check('el settings.json de hoy se lee igual, con el acceso remoto apagado',
      parsed.vault.enabled === true && json(parsed.remote) === json({ enabled: false, port: REMOTE_DEFAULT_PORT }), json(parsed));
    check('un puerto fuera de rango cae al de por defecto',
      parseAppSettings({ version: 1, remote: { enabled: true, port: 80 } }, process.platform).remote.port === REMOTE_DEFAULT_PORT &&
      parseAppSettings({ version: 1, remote: { enabled: true, port: 70000 } }, process.platform).remote.port === REMOTE_DEFAULT_PORT &&
      parseAppSettings({ version: 1, remote: { enabled: true, port: '30000' } }, process.platform).remote.port === REMOTE_DEFAULT_PORT);
    check('encendido sólo con un true de verdad',
      parseAppSettings({ version: 1, remote: { enabled: 'yes', port: 30000 } }, process.platform).remote.enabled === false);

    const file = path.join(workDir, 'settings', 'settings.json');
    const store = new SettingsStore(file, { log: { warn: () => undefined } });
    await store.load();
    await store.update({ remote: { enabled: true, port: 30000 } });
    await store.update({ vault: { enabled: true } });
    check('cambiar la copia propia no pierde el acceso remoto',
      json(store.get().remote) === json({ enabled: true, port: 30000 }) && store.get().vault.enabled === true, json(store.get()));
    await store.update({ remote: { enabled: false } });
    check('y un cambio parcial conserva el resto', store.get().remote.port === 30000 && store.get().vault.enabled === true);
    const before = json(store.get());
    const threw = await store.update({ remote: { port: 80 } }).then(() => false, () => true);
    check('un puerto inválido lanza y no cambia nada', threw && json(store.get()) === before);

    const reread = new SettingsStore(file, { log: { warn: () => undefined } });
    await reread.load();
    check('lo escrito se vuelve a leer', json(reread.get()) === before);
  }

  // --- 5. Las credenciales de una petición -------------------------------------
  {
    const token = 'token-del-arranque';
    const book = new DeviceBook({ now: () => 1, randomBytes: fakeRandom(), randomId: () => 'dev-x' });
    const { credential } = book.enroll('PC de juegos');
    const deviceCookie = `${DEVICE_COOKIE}=${encodeURIComponent(credential)}`;

    check('el token del arranque entra por dirección, cabecera y cookie',
      matchCredential(request({ url: `/?${TOKEN_QUERY_PARAM}=${token}` }), token, null)?.kind === 'session' &&
      matchCredential(request({ header: token }), token, null)?.kind === 'session' &&
      matchCredential(request({ cookie: `${TOKEN_COOKIE}=${token}` }), token, null)?.kind === 'session');
    const asDevice = matchCredential(request({ cookie: deviceCookie }), token, book);
    check('la cookie de un equipo emparejado entra, y dice cuál es',
      asDevice?.kind === 'device' && asDevice.deviceId === 'dev-x', json(asDevice));
    check('con el acceso apagado, la misma cookie no entra',
      matchCredential(request({ cookie: deviceCookie }), token, null) === null);
    check('si vienen las dos, manda el token del arranque',
      matchCredential(request({ cookie: `${TOKEN_COOKIE}=${token}; ${deviceCookie}` }), token, book)?.kind === 'session');
    check('la credencial de equipo no vale como token ni por dirección',
      matchCredential(request({ url: `/?${TOKEN_QUERY_PARAM}=${credential}` }), token, book) === null &&
      matchCredential(request({ header: credential }), token, book) === null);

    const lan = authorizeRequest(request({ host: `192.168.1.20:${REMOTE_DEFAULT_PORT}`, cookie: deviceCookie }), REMOTE_DEFAULT_PORT, token, book);
    check('por el nombre de red no se entra ni con credencial: sólo loopback', !lan.ok && lan.reason === 'bad-host', json(lan));
    const foreign = authorizeRequest(request({ origin: 'http://evil.example', cookie: deviceCookie }), REMOTE_DEFAULT_PORT, token, book);
    check('ni desde otro origen', !foreign.ok && foreign.reason === 'bad-origin', json(foreign));
    const otherPort = authorizeRequest(request({ host: '127.0.0.1:9999', cookie: deviceCookie }), REMOTE_DEFAULT_PORT, token, book);
    check('ni con otro puerto en el Host: el túnel usa el mismo en los dos extremos', !otherPort.ok && otherPort.reason === 'bad-host');
    const good = authorizeRequest(request({ host: `localhost:${REMOTE_DEFAULT_PORT}`, origin: `http://localhost:${REMOTE_DEFAULT_PORT}`, cookie: deviceCookie }), REMOTE_DEFAULT_PORT, token, book);
    check('por el túnel, como localhost, entra', good.ok && good.credential.kind === 'device', json(good));
    const none = authorizeRequest(request(), REMOTE_DEFAULT_PORT, token, book);
    check('sin nada, no', !none.ok && none.reason === 'bad-token');

    book.revoke('dev-x');
    check('revocado, deja de entrar', matchCredential(request({ cookie: deviceCookie }), token, book) === null);

    check('el código para emparejar sólo se lee de la dirección',
      readPairingCode(request({ url: `/?${PAIR_QUERY_PARAM}=K7QM-X2RD` })) === 'K7QM-X2RD' &&
      readPairingCode(request({ cookie: `${PAIR_QUERY_PARAM}=K7QM-X2RD` })) === null &&
      readPairingCode(request()) === null);

    const cookie = buildDeviceCookie(credential);
    check('la cookie del equipo es HttpOnly, SameSite=Strict y duradera',
      cookie.startsWith(`${DEVICE_COOKIE}=`) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) &&
      /Max-Age=\d{7,}/.test(cookie) && /Path=\//.test(cookie), cookie.replace(credential, '…'));
  }

  // --- 6. El servicio: qué corre y quién entra ---------------------------------
  {
    const makeService = async (name, { enabled, port = REMOTE_DEFAULT_PORT, listening }) => {
      const settings = new SettingsStore(path.join(workDir, name, 'settings.json'), { log: { warn: () => undefined } });
      await settings.load();
      if (enabled) await settings.update({ remote: { enabled: true, port } });
      const store = new RemoteDevicesStore(path.join(workDir, name, 'remote-devices.json'), { warn: () => undefined });
      const clock = fakeClock();
      const service = new RemoteAccessService({
        settings,
        store,
        listening,
        host: { user: 'ana', hostNames: ['PC-ANA', '192.168.1.20'] },
        now: clock.now,
        randomBytes: fakeRandom(),
        log: { log: () => undefined, warn: () => undefined },
      });
      await service.load();
      return { service, settings, clock };
    };

    const off = await makeService('off', { enabled: false, listening: { port: 51234, fixed: false, fixedPortBusy: false } });
    check('apagado: estado off y ningún equipo entra', off.service.status().state === 'off' && off.service.verifier() === null);
    check('apagado no se puede emparejar',
      (() => { try { off.service.startPairing(); return false; } catch (error) { return error instanceof ServerTextError && error.text.key === 'remoteNotActive'; } })());
    check('ni canjear un código', (await off.service.redeemPairing('AAAA-AAAA', 'Mozilla')) === null);

    const pending = await makeService('pending', { enabled: true, listening: { port: 51234, fixed: false, fixedPortBusy: false } });
    check('encendido sin reiniciar: falta reiniciar, y todavía no entra nadie',
      pending.service.status().state === 'restart-needed' && pending.service.verifier() === null);

    const busy = await makeService('busy', { enabled: true, listening: { port: 51234, fixed: false, fixedPortBusy: true } });
    check('con el puerto ocupado lo dice', busy.service.status().state === 'port-busy' && busy.service.verifier() === null);

    const { service, settings } = await makeService('active', {
      enabled: true,
      listening: { port: REMOTE_DEFAULT_PORT, fixed: true, fixedPortBusy: false },
    });
    check('encendido y en su puerto: activo', service.status().state === 'active' && service.verifier() !== null);
    check('el estado trae con qué usuario y a qué nombres conectarse',
      service.status().sshUser === 'ana' && json(service.status().hostNames) === json(['PC-ANA', '192.168.1.20']));

    let changes = 0;
    const revoked = [];
    service.onChange(() => { changes += 1; });
    service.onRevoked((deviceId) => revoked.push(deviceId));

    const pairing = service.startPairing();
    check('pedir un código avisa el cambio y el estado dice que hay uno vigente',
      changes === 1 && service.status().pairingActive === true && !json(service.status()).includes(pairing.code.replace('-', '')));
    check('un código equivocado no empareja', (await service.redeemPairing('AAAA-AAAA', 'Mozilla')) === null && service.status().devices.length === 0);
    const redeemed = await service.redeemPairing(pairing.code, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36');
    check('el bueno empareja y entrega la credencial',
      redeemed !== null && service.verifier().match(redeemed.credential)?.id === redeemed.deviceId);
    check('el equipo aparece con un nombre sacado del navegador, y el código ya no está vigente',
      service.status().devices[0]?.label === 'Chrome · Windows' && service.status().pairingActive === false, json(service.status().devices));
    check('el estado nunca lleva la credencial ni el hash',
      !json(service.status()).includes(redeemed.credential) && !json(service.status()).includes('hash'));
    await service.flush();
    const onDisk = await readFile(path.join(workDir, 'active', 'remote-devices.json'), 'utf8');
    check('el equipo quedó guardado, sin la credencial', onDisk.includes(redeemed.deviceId) && !onDisk.includes(redeemed.credential));

    service.noteConnected(redeemed.deviceId);
    check('se sabe si un equipo está conectado', service.status().devices[0].connected === true);
    service.noteDisconnected(redeemed.deviceId);
    check('y cuándo deja de estarlo', service.status().devices[0].connected === false);

    const badPort = await service.configure({ port: 80 }).then(() => null, (error) => error);
    check('un puerto inválido se rechaza con su texto, sin tocar los ajustes',
      badPort instanceof ServerTextError && badPort.text.key === 'remotePortInvalid' && settings.get().remote.port === REMOTE_DEFAULT_PORT);

    await service.configure({ port: 30000 });
    check('cambiar el puerto pide reiniciar, y el equipo sigue entrando por el de ahora',
      service.status().state === 'restart-needed' && service.verifier()?.match(redeemed.credential) !== null);
    await service.configure({ port: REMOTE_DEFAULT_PORT });

    check('revocar avisa qué equipo cerrar', (await service.revokeDevice(redeemed.deviceId)) && json(revoked) === json([redeemed.deviceId]));
    check('y deja de entrar', service.verifier().match(redeemed.credential) === null);

    const again = await service.redeemPairing(service.startPairing().code, 'curl/8');
    await service.configure({ enabled: false });
    check('apagar corta en el acto: nadie entra, se avisa cerrar a todos y el código muere',
      service.status().state === 'off' && service.verifier() === null && revoked.at(-1) === null &&
      service.status().pairingActive === false && again !== null);
    await service.configure({ enabled: true });
    check('volver a encender, con el servidor en su puerto, no pide reiniciar',
      service.status().state === 'active' && service.verifier()?.match(again.credential) !== null);
  }

  // --- 6b. Dos instancias de la app sobre la misma carpeta ----------------------
  // El caso de todos los días: `pnpm dev` al lado de la de uso. Una tiene el
  // puerto; la otra cayó a uno efímero. Comparten los dos archivos.
  {
    const dir = path.join(workDir, 'dos-instancias');
    const instance = async (listening) => {
      const settings = new SettingsStore(path.join(dir, 'settings.json'), { log: { warn: () => undefined } });
      await settings.load();
      const service = new RemoteAccessService({
        settings,
        store: new RemoteDevicesStore(path.join(dir, 'remote-devices.json'), { warn: () => undefined }),
        listening,
        host: { user: 'ana', hostNames: ['PC-ANA'] },
        log: { log: () => undefined, warn: () => undefined },
      });
      await service.load();
      return { service, settings };
    };

    const seed = new SettingsStore(path.join(dir, 'settings.json'), { log: { warn: () => undefined } });
    await seed.load();
    await seed.update({ remote: { enabled: true } });

    const owner = await instance({ port: REMOTE_DEFAULT_PORT, fixed: true, fixedPortBusy: false });
    const other = await instance({ port: 50123, fixed: false, fixedPortBusy: true });
    const ownerRevoked = [];
    owner.service.onRevoked((deviceId) => ownerRevoked.push(deviceId));

    const first = await owner.service.redeemPairing(owner.service.startPairing().code, 'Mozilla');
    const second = await owner.service.redeemPairing(owner.service.startPairing().code, 'Mozilla');
    await other.service.sync();
    check('la otra instancia ve los equipos que emparejó la que tiene el puerto', other.service.status().devices.length === 2);

    check('un equipo revocado desde la otra instancia…', await other.service.revokeDevice(first.deviceId));
    check('…sigue entrando en la del puerto sólo hasta que mira el archivo',
      owner.service.verifier().match(first.credential) !== null);
    await owner.service.sync();
    check('…y ahí deja de entrar, y se avisa cerrar sus ventanas',
      owner.service.verifier().match(first.credential) === null && json(ownerRevoked) === json([first.deviceId]) &&
      owner.service.verifier().match(second.credential) !== null);

    // La del puerto revoca; la otra, que todavía recuerda a ese equipo, renombra a otro.
    const third = await owner.service.redeemPairing(owner.service.startPairing().code, 'Mozilla');
    await other.service.sync();
    await owner.service.revokeDevice(third.deviceId);
    await other.service.renameDevice(second.deviceId, 'PC de juegos');
    await owner.service.sync();
    const onDisk = await readFile(path.join(dir, 'remote-devices.json'), 'utf8');
    check('una lista vieja no resucita a un equipo revocado: se relee antes de escribir',
      !onDisk.includes(third.deviceId) && owner.service.verifier().match(third.credential) === null &&
      owner.service.status().devices.map((device) => device.label).join() === 'PC de juegos', onDisk.length + ' bytes');

    await other.service.configure({ enabled: false });
    check('apagado desde la otra instancia, la del puerto todavía no lo sabe', owner.service.verifier() !== null);
    await owner.service.sync();
    check('…y al mirar el archivo corta: nadie entra y se avisa cerrar a todos',
      owner.service.verifier() === null && owner.service.status().state === 'off' && ownerRevoked.at(-1) === null);

    await owner.service.configure({ enabled: true });
    await other.settings.update({ vault: { enabled: true } });
    await owner.service.sync();
    check('un cambio de la copia propia desde otra instancia no pisa el acceso remoto con lo que recordaba',
      owner.service.status().state === 'active' &&
      JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).remote.enabled === true);
    owner.service.dispose();
    other.service.dispose();
  }

  // --- 7. Qué corre según los ajustes y el arranque ----------------------------
  {
    const fixed = { port: REMOTE_DEFAULT_PORT, fixed: true, fixedPortBusy: false };
    check('apagado es off aunque el servidor siga en el puerto fijo',
      remoteAccessState({ enabled: false, port: REMOTE_DEFAULT_PORT }, fixed) === 'off');
    check('encendido y en su puerto es active', remoteAccessState({ enabled: true, port: REMOTE_DEFAULT_PORT }, fixed) === 'active');
    check('con otro puerto en los ajustes, restart-needed', remoteAccessState({ enabled: true, port: 30000 }, fixed) === 'restart-needed');
    check('con el servidor en un puerto efímero, restart-needed',
      remoteAccessState({ enabled: true, port: REMOTE_DEFAULT_PORT }, { port: 50000, fixed: false, fixedPortBusy: false }) === 'restart-needed');
    check('y si el fijo estaba ocupado, port-busy',
      remoteAccessState({ enabled: true, port: REMOTE_DEFAULT_PORT }, { port: 50000, fixed: false, fixedPortBusy: true }) === 'port-busy');
  }

  // --- 8. La línea del arranque ------------------------------------------------
  {
    check('apagado no suma ninguna línea', remoteAccessStartupLine('off', REMOTE_DEFAULT_PORT, 3) === null);
    check('activo dice el puerto y cuántos equipos',
      remoteAccessStartupLine('active', REMOTE_DEFAULT_PORT, 1) === `  Remote access  on, port ${REMOTE_DEFAULT_PORT}, 1 paired device` &&
      remoteAccessStartupLine('active', REMOTE_DEFAULT_PORT, 2)?.endsWith('2 paired devices'));
    check('con el puerto ocupado lo dice',
      /busy/.test(remoteAccessStartupLine('port-busy', REMOTE_DEFAULT_PORT, 0) ?? ''));
  }

  // --- 9. Lo que se arma del sistema -------------------------------------------
  {
    const interfaces = {
      'Wi-Fi': [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.1.20', family: 'IPv4', internal: false },
      ],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      VPN: [{ address: '10.8.0.3', family: 'IPv4', internal: false }],
      Rara: [{ address: '8.8.8.8', family: 'IPv4', internal: false }, { address: '172.20.1.1', family: 'IPv4', internal: false }],
      Fuera: [{ address: '172.32.0.1', family: 'IPv4', internal: false }],
    };
    check('de las interfaces salen sólo las IPv4 privadas',
      json(privateIpv4Addresses(interfaces)) === json(['192.168.1.20', '10.8.0.3', '172.20.1.1']), json(privateIpv4Addresses(interfaces)));
    check('el nombre del equipo sale del navegador y del sistema',
      deviceLabelFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0') === 'Firefox · Linux' &&
      deviceLabelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15') === 'Safari · macOS' &&
      deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0') === 'Edge · Windows');
    check('y si no se reconoce, un nombre genérico', deviceLabelFromUserAgent(undefined) === 'Device' && deviceLabelFromUserAgent('curl/8.0') === 'Device');
  }

  // --- 10. Lo que un equipo remoto no puede pedir -------------------------------
  {
    const hostOnly = ['remote.configure', 'remote.pairing.start', 'remote.pairing.cancel', 'remote.device.rename', 'remote.device.revoke'];
    const opensOnHost = ['files.reveal', 'vault.reveal', 'vault.openSession', 'vault.exportProject'];
    check('administrar el acceso remoto es sólo del anfitrión',
      hostOnly.every((type) => remoteRefusal(type, true)?.key === 'remoteHostOnly'));
    check('lo que abre una ventana en el anfitrión se le niega',
      opensOnHost.every((type) => remoteRefusal(type, true)?.key === 'remoteOpensOnHost'));
    check('todo lo demás lo puede pedir',
      ['input', 'agent.submit', 'terminal.open', 'files.read', 'vault.enable', 'notes.create'].every((type) => remoteRefusal(type, true) === null));
    check('al anfitrión no se le niega nada',
      [...hostOnly, ...opensOnHost, 'input'].every((type) => remoteRefusal(type, false) === null));
  }

  // --- 11. El protocolo --------------------------------------------------------
  {
    const client = (message) => parseClientMessage(JSON.stringify(message));
    check('remote.configure lleva encendido o puerto',
      json(client({ type: 'remote.configure', enabled: true })) === json({ type: 'remote.configure', enabled: true }) &&
      json(client({ type: 'remote.configure', port: 30000 })) === json({ type: 'remote.configure', port: 30000 }) &&
      client({ type: 'remote.configure' }) === null &&
      client({ type: 'remote.configure', port: 'x' }) === null &&
      client({ type: 'remote.configure', enabled: 'si' }) === null);
    check('los pedidos de emparejar no llevan nada',
      client({ type: 'remote.pairing.start' })?.type === 'remote.pairing.start' &&
      client({ type: 'remote.pairing.cancel' })?.type === 'remote.pairing.cancel');
    check('renombrar y revocar van por id',
      client({ type: 'remote.device.rename', deviceId: 'a', label: 'PC' })?.label === 'PC' &&
      client({ type: 'remote.device.rename', deviceId: 'a' }) === null &&
      client({ type: 'remote.device.revoke', deviceId: 'a' })?.deviceId === 'a' &&
      client({ type: 'remote.device.revoke', deviceId: '' }) === null);

    const status = {
      enabled: true, port: REMOTE_DEFAULT_PORT, state: 'active', listeningPort: REMOTE_DEFAULT_PORT,
      sshUser: 'ana', hostNames: ['PC-ANA'], pairingActive: false,
      devices: [{ id: 'a', label: 'PC', createdAt: 1, lastSeenAt: null, connected: false }],
    };
    const server = (message) => parseServerMessage(JSON.stringify(message));
    check('remote.status se lee entero', json(server({ type: 'remote.status', status })?.status) === json(status));
    check('con un estado que no existe, no', server({ type: 'remote.status', status: { ...status, state: 'raro' } }) === null);
    check('remote.pairing.code trae el código y su vencimiento',
      json(server({ type: 'remote.pairing.code', pairing: { code: 'K7QM-X2RD', expiresAt: 9 } })?.pairing) === json({ code: 'K7QM-X2RD', expiresAt: 9 }));

    const hello = { type: 'hello', protocolVersion: 8, agents: [], defaultAgent: null, platform: 'win32', defaultCwd: 'D:\\x', shellName: null };
    check('hello dice si esta ventana es un equipo remoto',
      server({ ...hello, remoteClient: true })?.remoteClient === true && server(hello)?.remoteClient === false);
    check('el error de un pedido negado a un remoto se lee',
      server({ type: 'error', code: 'remote-refused', text: { key: 'remoteHostOnly' } })?.code === 'remote-refused');
  }

  // --- 12. Lo que la interfaz arma para copiar ---------------------------------
  {
    const status = { port: REMOTE_DEFAULT_PORT, sshUser: 'ana' };
    check('el comando del túnel usa el mismo puerto en los dos extremos, y 127.0.0.1 del lado de acá',
      sshTunnelCommand(status, 'PC-ANA') === `ssh -N -L ${REMOTE_DEFAULT_PORT}:127.0.0.1:${REMOTE_DEFAULT_PORT} ana@PC-ANA`,
      sshTunnelCommand(status, 'PC-ANA'));
    check('un usuario con espacio va entre comillas',
      sshTunnelCommand({ ...status, sshUser: 'Ana Perez' }, '192.168.1.20').endsWith('"Ana Perez@192.168.1.20"'));
    check('sin usuario queda un marcador que se nota',
      sshTunnelCommand({ ...status, sshUser: '' }, 'PC-ANA').endsWith('USER@PC-ANA'));
    check('el otro equipo abre localhost, nunca el nombre de red', remoteUrl(REMOTE_DEFAULT_PORT) === `http://localhost:${REMOTE_DEFAULT_PORT}`);

    const url = pairingUrl(REMOTE_DEFAULT_PORT, 'K7QM-X2RD');
    check('la dirección para emparejar lleva el código', url === `http://localhost:${REMOTE_DEFAULT_PORT}/?${PAIR_QUERY_PARAM}=K7QM-X2RD`, url);
    const parsed = new URL(url);
    check('y es la que el servidor sabe leer y canjear',
      readPairingCode({ url: parsed.pathname + parsed.search, headers: { host: parsed.host } }) === 'K7QM-X2RD' &&
      normalizePairingCode('K7QM-X2RD') === 'K7QMX2RD');

    check('el primer nombre es el del equipo; sin ninguno, localhost',
      defaultHostName(['PC-ANA', '192.168.1.20']) === 'PC-ANA' && defaultHostName([]) === 'localhost');
    check('el puerto tecleado: sólo dígitos y en rango',
      parsePortInput('24837') === 24837 && parsePortInput(' 30000 ') === 30000 &&
      [ '80', '70000', '2e4', '24837.5', '', 'abc', '-1', '123456' ].every((text) => parsePortInput(text) === null));
    check('la cuenta regresiva', pairingSecondsLeft(300_000, 999) === 300 && pairingSecondsLeft(1_000, 5_000) === 0 &&
      formatCountdown(300) === '5:00' && formatCountdown(67) === '1:07' && formatCountdown(0) === '0:00');
    check('se empareja sólo con el acceso activo',
      canPair({ state: 'active' }) && !canPair({ state: 'restart-needed' }) && !canPair({ state: 'port-busy' }) &&
      !canPair({ state: 'off' }) && !canPair(null));
    check('cada estado tiene su texto',
      remoteStateText('off', 1) === 'Apagado' && remoteStateText('active', 24837) === 'Encendido, puerto 24837' &&
      /reinicies/.test(remoteStateText('restart-needed', 1)) && /24837 está ocupado/.test(remoteStateText('port-busy', 24837)));
    const device = { id: 'a', label: 'PC', createdAt: 1, lastSeenAt: null, connected: false };
    check('de un equipo se dice si está, si nunca estuvo o cuándo se lo vio',
      deviceSeenText({ ...device, connected: true }) === 'Conectado ahora' &&
      deviceSeenText(device) === 'Nunca se conectó' &&
      deviceSeenText({ ...device, lastSeenAt: 1_000_000 }, 1_000_000 + 5 * 60_000) === 'Última vez: hace 5 min');
  }

  // --- 13. La notificación del sistema -----------------------------------------
  {
    check('sale sólo encendida, con permiso y sin la ventana a la vista',
      shouldNotify(true, 'granted', false) &&
      !shouldNotify(true, 'granted', true) && !shouldNotify(false, 'granted', false) &&
      !shouldNotify(true, 'denied', false) && !shouldNotify(true, 'default', false) && !shouldNotify(true, 'unsupported', false));
    check('la preferencia guardada se lee, y otra cosa no es ninguna',
      parseStoredNotify('on') === true && parseStoredNotify('off') === false && parseStoredNotify('si') === null);
    check('con el permiso negado el botón lo dice, esté como esté',
      /bloqueando/.test(notifyButtonTitle(true, 'denied')) && /bloqueando/.test(notifyButtonTitle(false, 'denied')) &&
      /apagadas/.test(notifyButtonTitle(false, 'default')) && /activadas/.test(notifyButtonTitle(true, 'granted')));
    check('el aviso nombra la pestaña y dice cuál de las dos cosas pasó',
      notificationBody('done', 'mi-app') === '«mi-app» terminó' && notificationBody('attention', 'mi-app') === '«mi-app» te espera');
    check('el nombre es la etiqueta, o la última carpeta de la ruta',
      tabNameFor({ label: 'Backend', cwd: 'D:\\Mi App' }) === 'Backend' &&
      tabNameFor({ label: '', cwd: 'D:\\Proyectos\\Mi App\\' }) === 'Mi App' &&
      tabNameFor({ label: '', cwd: '/home/ana/mi-app' }) === 'mi-app' && tabNameFor(undefined) === '');
  }
  // --- 14. El teléfono (hito 38, §15) -------------------------------------------
  {
    // RFC 8032, prueba 1: la pública de esa semilla es esa.
    const rfcSeed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    check('la pública Ed25519 sale de la semilla, como dice la RFC 8032',
      ed25519PublicKey(rfcSeed).toString('hex') === 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    check('una semilla que no tiene 32 bytes no es una llave',
      (() => { try { ed25519PublicKey(Buffer.alloc(31)); return false; } catch { return true; } })());
    const publicLine = sshEd25519PublicKey(ed25519PublicKey(rfcSeed));
    check('la pública va en el formato de OpenSSH',
      publicLine === 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea', publicLine);

    const entry = phoneAuthorizedKeysEntry(ed25519PublicKey(rfcSeed), 24837);
    const options = entry.split(' ')[0];
    check('la línea deja solo el túnel hacia el puerto de la app, y no ejecuta nada',
      options === 'restrict,port-forwarding,permitopen="127.0.0.1:24837",command="exit"', options);
    check('la línea lleva la pública y dice de dónde salió',
      entry.endsWith(`${publicLine} ${PHONE_KEY_COMMENT}`) && !entry.includes("'"));

    const admin = phoneAuthorizeCommand(entry, 'powershell-admin');
    check('administrador: la lista de administradores, con permisos por SID y sin nombres de grupo',
      admin.includes('administrators_authorized_keys') && admin.includes("'*S-1-5-32-544:F'") && admin.includes("'*S-1-5-18:F'") &&
      admin.includes('/inheritance:r') && !/Administrators|Administradores|SYSTEM:/.test(admin));
    const plain = phoneAuthorizeCommand(entry, 'powershell');
    check('usuario común: su authorized_keys, sin tocar permisos',
      plain.includes('$HOME\\.ssh\\authorized_keys') && !plain.includes('icacls') && !plain.includes('administrators'));
    const unix = phoneAuthorizeCommand(entry, 'terminal');
    check('macOS y Linux: ~/.ssh con los permisos que pide StrictModes',
      unix.includes('~/.ssh/authorized_keys') && unix.includes('chmod 700 ~/.ssh') && unix.includes('chmod 600'));
    check('en los tres la línea va entera y entre comillas simples',
      [admin, plain, unix].every((command) => command.includes(`'${entry}'`)));
    check('whoami con el grupo de administradores es la consola de administrador; sin él, la común',
      authorizeShellFromGroups('"BUILTIN\\Administradores","Alias","S-1-5-32-544","Grupo usado solo para denegar"') === 'powershell-admin' &&
      authorizeShellFromGroups('"BUILTIN\\Usuarios","Alias","S-1-5-32-545","Grupo obligatorio"') === 'powershell');

    const payload = phonePairingPayload({
      pcName: 'PC Ana', hosts: ['192.168.1.20', '10.0.0.5'], sshPort: 22, user: 'Ana Pérez', appPort: 24837, code: 'K7QMX2RD', seed: rfcSeed,
    });
    const back = parsePhonePairingPayload(payload);
    check('el QR se lee igual que se escribió',
      back !== null && back.pcName === 'PC Ana' && json(back.hosts) === json(['192.168.1.20', '10.0.0.5']) && back.sshPort === 22 &&
      back.user === 'Ana Pérez' && back.appPort === 24837 && back.code === 'K7QMX2RD' && back.seed.equals(rfcSeed), payload);
    const keys = [...new URLSearchParams(payload.slice(PHONE_PAYLOAD_PREFIX.length)).keys()];
    check('el QR lleva exactamente lo que necesita el teléfono: ni el token ni nada de más',
      json(keys) === json(['v', 'n', 'h', 'p', 'u', 'a', 'c', 'k']) && payload.startsWith(PHONE_PAYLOAD_PREFIX), json(keys));
    check('el QR es ASCII: el generador codifica bytes', /^[\x21-\x7e]+$/.test(payload));
    check('otra versión, un prefijo ajeno o una semilla corta no se leen',
      parsePhonePairingPayload(payload.replace('v=1', 'v=2')) === null &&
      parsePhonePairingPayload(payload.replace('agentworkbench://pair?', 'https://x/?')) === null &&
      parsePhonePairingPayload(payload.replace(/k=[^&]+/, 'k=AAAA')) === null);

    // El servicio: sólo con el acceso activo, y la llave vive mientras no se cancele.
    const makePhoneService = async (name, enabled) => {
      const settings = new SettingsStore(path.join(workDir, name, 'settings.json'), { log: { warn: () => undefined } });
      await settings.load();
      if (enabled) await settings.update({ remote: { enabled: true, port: REMOTE_DEFAULT_PORT } });
      const service = new RemoteAccessService({
        settings,
        store: new RemoteDevicesStore(path.join(workDir, name, 'remote-devices.json'), { warn: () => undefined }),
        listening: { port: REMOTE_DEFAULT_PORT, fixed: enabled, fixedPortBusy: false },
        host: { user: 'ana', hostNames: ['PC-ANA', '192.168.1.20'] },
        now: fakeClock().now,
        randomBytes: (size) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + size) % 256)),
        log: { log: () => undefined, warn: () => undefined },
        authorizeShell: async () => 'powershell-admin',
      });
      await service.load();
      return service;
    };
    const offPhone = await makePhoneService('phone-off', false);
    check('apagado no se empareja un teléfono',
      await offPhone.startPhonePairing().then(() => false, (error) => error instanceof ServerTextError && error.text.key === 'remoteNotActive'));

    const phone = await makePhoneService('phone-on', true);
    const first = await phone.startPhonePairing();
    const firstFields = parsePhonePairingPayload(first.payload);
    check('encendido: el QR lleva este equipo, su IP, el usuario, el puerto de este arranque y el código vigente',
      firstFields !== null && firstFields.pcName === 'PC-ANA' && json(firstFields.hosts) === json(['192.168.1.20']) &&
      firstFields.user === 'ana' && firstFields.appPort === REMOTE_DEFAULT_PORT && firstFields.sshPort === 22 &&
      firstFields.code === first.code.replace('-', '') && phone.status().pairingActive, first.payload);
    check('la línea que se pega es la de esa llave, para la consola que corresponde',
      first.shell === 'powershell-admin' &&
      first.authorizeCommand.includes(sshEd25519PublicKey(ed25519PublicKey(firstFields?.seed ?? Buffer.alloc(32)))));
    const second = await phone.startPhonePairing();
    const secondFields = parsePhonePairingPayload(second.payload);
    check('pedir otro código conserva la llave: no hay que autorizar otra',
      secondFields !== null && firstFields !== null && secondFields.seed.equals(firstFields.seed) &&
      second.authorizeCommand === first.authorizeCommand && phone.phoneKeyHeld);
    phone.cancelPhonePairing();
    check('cancelar olvida la llave y da de baja el código', !phone.phoneKeyHeld && !phone.status().pairingActive);
    const third = await phone.startPhonePairing();
    const redeemed = await phone.redeemPairing(third.code, 'Mozilla/5.0 AgentWorkbenchAndroid/0.1.0 (Android 15; Galaxy A16)');
    check('canjeado el código, la llave ya viajó y no se guarda; el equipo lleva el nombre del teléfono',
      redeemed !== null && !phone.phoneKeyHeld && phone.status().devices.some((device) => device.label === 'Galaxy A16 · Android'));

    check('un equipo remoto no puede emparejar un teléfono',
      remoteRefusal('remote.phone.start', true)?.key === 'remoteHostOnly' && remoteRefusal('remote.phone.cancel', true)?.key === 'remoteHostOnly' &&
      remoteRefusal('remote.phone.start', false) === null);
    check('el nombre del teléfono, acotado; sin nombre, Android',
      deviceLabelFromUserAgent(`AgentWorkbenchAndroid/0.1.0 (Android 15; ${'x'.repeat(70)})`).length <= REMOTE_DEVICE_LABEL_MAX_CHARS &&
      deviceLabelFromUserAgent('AgentWorkbenchAndroid/0.1.0 (Android 15;  )') === 'Android');

    check('el protocolo: los dos pedidos y la respuesta',
      parseClientMessage(json({ type: 'remote.phone.start' }))?.type === 'remote.phone.start' &&
      parseClientMessage(json({ type: 'remote.phone.cancel' }))?.type === 'remote.phone.cancel' &&
      parseServerMessage(json({ type: 'remote.phone.pairing', pairing: first }))?.type === 'remote.phone.pairing' &&
      parseServerMessage(json({ type: 'remote.phone.pairing', pairing: { ...first, shell: 'cmd' } })) === null);

    const matrix = qrMatrix(first.payload);
    const finder = (row, col) =>
      qrModuleDark(matrix, row, col) && qrModuleDark(matrix, row, col + 6) && qrModuleDark(matrix, row + 6, col) &&
      qrModuleDark(matrix, row + 2, col + 2) && !qrModuleDark(matrix, row + 1, col + 1);
    check('el QR tiene el tamaño de una versión y sus tres marcas de esquina',
      matrix.size >= 21 && (matrix.size - 17) % 4 === 0 && finder(0, 0) && finder(0, matrix.size - 7) && finder(matrix.size - 7, 0),
      `${matrix.size} módulos`);
    check('la interfaz dice dónde pegar la línea',
      /PowerShell como administrador/.test(phoneAuthorizeText('powershell-admin')) &&
      /en PowerShell\.$/.test(phoneAuthorizeText('powershell')) && /una terminal/.test(phoneAuthorizeText('terminal')));
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
