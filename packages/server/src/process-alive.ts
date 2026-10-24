/**
 * Si un proceso existe, por su pid (hito 51). Lo usan el archivo de estado de
 * Claude Code, que deja el de una CLI matada a la fuerza, y el reclamo de un
 * mensaje programado, que deja el de una instancia que se cerro de golpe.
 *
 * `kill(pid, 0)` no manda ninguna senal: solo pregunta. Si el proceso existe
 * pero es de otro usuario contesta EPERM, y eso tambien es "existe".
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
