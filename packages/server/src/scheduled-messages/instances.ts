/**
 * Las instancias de la app que estan corriendo sobre la misma carpeta de
 * configuracion (hito 52, §6.39).
 *
 * Cada instancia deja `instances/<pid>.json` mientras corre. Lo usa el reloj de
 * los mensajes programados con las CLIs que no dicen si otro proceso tiene la
 * conversacion abierta (todas menos Claude Code): si hay otra instancia
 * corriendo, la que tiene la pestana dormida espera un minuto antes de abrirla,
 * porque la que la tiene abierta lo reserva en cuanto vence (51). Sin esto, las
 * dos abririan la misma conversacion.
 *
 * El archivo de una instancia que se cerro de golpe queda: se reconoce por su
 * pid, que ya no vive, y se borra al verlo. Un pid reusado por otro programa
 * hace esperar el minuto de mas, y nada mas.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runningInstancesDir } from '../paths.js';
import { processAlive } from '../process-alive.js';

const FILE_PATTERN = /^(\d+)\.json$/;

export class RunningInstances {
  constructor(
    private readonly dir: string = runningInstancesDir(),
    private readonly pid: number = process.pid,
    private readonly isAlive: (pid: number) => boolean = processAlive,
  ) {}

  private fileOf(pid: number): string {
    return path.join(this.dir, `${pid}.json`);
  }

  /** Anota esta instancia. Nunca lanza: sin el archivo, la otra no espera, como antes del hito. */
  async register(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.fileOf(this.pid), `${JSON.stringify({ pid: this.pid, startedAt: Date.now() })}\n`);
    } catch (error) {
      console.warn('[scheduled] couldn\'t note this instance:', error);
    }
  }

  /** La saca, al apagarse. Nunca lanza. */
  async unregister(): Promise<void> {
    await rm(this.fileOf(this.pid), { force: true }).catch(() => undefined);
  }

  /** true si otra instancia esta corriendo. Borra los archivos de las que ya no estan. */
  async othersRunning(): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return false;
    }
    let found = false;
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (pid === this.pid) continue;
      if (this.isAlive(pid)) found = true;
      else await rm(this.fileOf(pid), { force: true }).catch(() => undefined);
    }
    return found;
  }
}
