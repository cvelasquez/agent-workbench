/**
 * El ícono de rama (hito 48): dos ramas que salen de un tronco. Dibujado a mano
 * por lo mismo que la caja de archivo de la barra: un paquete de íconos entero
 * para un glifo no vale la pena, y uno de un CDN sería una llamada de red
 * (§2.4). `currentColor` lo deja seguir el color del botón en los dos temas.
 */
export function BranchIcon(): JSX.Element {
  return (
    <svg
      className="archive-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 9.2c0 4.3-5.5 4-10.4 7.8" />
    </svg>
  );
}

/**
 * "Pasar a una rama aparte" (hito 54): el tronco y una flecha que sale hacia la
 * rama. Distinto del de sesión nueva: en Cambios van uno al lado del otro, y
 * con el mismo dibujo no se distinguían.
 */
export function MoveBranchIcon(): JSX.Element {
  return (
    <svg
      className="archive-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M8.5 12h11" />
      <path d="M16 8.5l3.5 3.5-3.5 3.5" />
    </svg>
  );
}
