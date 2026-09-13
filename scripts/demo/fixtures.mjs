/**
 * Datos ficticios para `pnpm demo` y `pnpm demo:shots`.
 *
 * Genera, en una carpeta temporal, todo lo que la app lee de la maquina:
 *
 *   <root>/Proyectos/<nombre>       proyectos inventados; uno con git y cambios
 *   <home>/.claude/projects/<slug>  sesiones JSONL sinteticas, con el esquema real
 *   <configDir>/workspace.json      tres pestanas abiertas al arrancar
 *   <bin>/claude(.cmd)              CLI simulada: contesta --version y se queda
 *
 * Los nombres son inventados a proposito: las capturas del README son publicas
 * y no pueden mostrar proyectos reales. Ninguna ruta lleva el usuario de la
 * maquina: en Windows la carpeta se monta como unidad `W:` (ver environment.mjs).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CLI_VERSION = '2.1.263';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function write(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(base, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ana Torres',
      GIT_AUTHOR_EMAIL: 'ana@example.com',
      GIT_COMMITTER_NAME: 'Ana Torres',
      GIT_COMMITTER_EMAIL: 'ana@example.com',
    },
  }).toString();
}

function commit(cwd, message, when) {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ana Torres',
      GIT_AUTHOR_EMAIL: 'ana@example.com',
      GIT_COMMITTER_NAME: 'Ana Torres',
      GIT_COMMITTER_EMAIL: 'ana@example.com',
      GIT_AUTHOR_DATE: new Date(when).toISOString(),
      GIT_COMMITTER_DATE: new Date(when).toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// tienda-online: contenido de los archivos
// ---------------------------------------------------------------------------
const cartProviderBefore = `import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CartItem } from './types';

interface CartContextValue {
  items: CartItem[];
  add: (item: CartItem) => void;
  remove: (productId: string) => void;
  clear: () => void;
  total: number;
}

export const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  useEffect(() => {
    localStorage.setItem('cart', JSON.stringify(items));
  }, [items]);

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      add: (item) =>
        setItems((current) => {
          const existing = current.find((entry) => entry.productId === item.productId);
          if (existing === undefined) return [...current, item];
          return current.map((entry) =>
            entry.productId === item.productId
              ? { ...entry, quantity: entry.quantity + item.quantity }
              : entry,
          );
        }),
      remove: (productId) =>
        setItems((current) => current.filter((entry) => entry.productId !== productId)),
      clear: () => setItems([]),
      total: items.reduce((sum, entry) => sum + entry.price * entry.quantity, 0),
    }),
    [items],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
`;

const cartProviderAfter = cartProviderBefore
  .replace(
    "import type { CartItem } from './types';",
    "import { loadCart, saveCart } from './storage';\nimport type { CartItem } from './types';",
  )
  .replace(
    `  const [items, setItems] = useState<CartItem[]>([]);

  useEffect(() => {
    localStorage.setItem('cart', JSON.stringify(items));
  }, [items]);`,
    `  // Se lee una sola vez, en el inicializador. Si el estado arrancara en [],
  // el primer efecto pisaria lo guardado antes de haberlo leido: ese era el
  // bug que vaciaba el carrito en cada recarga.
  const [items, setItems] = useState<CartItem[]>(() => loadCart());

  useEffect(() => {
    saveCart(items);
  }, [items]);`,
  );

const useCartBefore = `import { useContext } from 'react';
import { CartContext } from './CartProvider';

export function useCart() {
  const context = useContext(CartContext);
  if (context === null) throw new Error('useCart necesita un CartProvider');
  return context;
}
`;

const useCartAfter = `import { useContext } from 'react';
import { CartContext } from './CartProvider';

export function useCart() {
  const context = useContext(CartContext);
  if (context === null) {
    throw new Error('useCart se llamo fuera de <CartProvider>. Envolve la app en App.tsx.');
  }
  return context;
}

/** Cantidad total de unidades, para la pastilla del icono del carrito. */
export function useCartCount(): number {
  const { items } = useCart();
  return items.reduce((sum, entry) => sum + entry.quantity, 0);
}
`;

const cartTestBefore = `import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CartProvider } from '../src/cart/CartProvider';
import { useCart } from '../src/cart/useCart';

const polera = { productId: 'p-101', name: 'Polera gris', price: 59.9, quantity: 1 };

describe('carrito', () => {
  it('agrega un producto', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add(polera));
    expect(result.current.items).toHaveLength(1);
  });

  it('suma cantidades del mismo producto', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add(polera));
    act(() => result.current.add({ ...polera, quantity: 2 }));
    expect(result.current.items[0]?.quantity).toBe(3);
  });

  it('calcula el total', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add({ ...polera, quantity: 2 }));
    expect(result.current.total).toBeCloseTo(119.8);
  });
});
`;

const cartTestAfter = cartTestBefore.replace(
  `  it('calcula el total', () => {`,
  `  it('sobrevive a una recarga', () => {
    const first = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => first.result.current.add(polera));
    first.unmount();

    const second = renderHook(() => useCart(), { wrapper: CartProvider });
    expect(second.result.current.items).toEqual([polera]);
  });

  it('ignora un valor guardado corrupto', () => {
    localStorage.setItem('tienda.cart', '{no es json');
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    expect(result.current.items).toEqual([]);
  });

  it('calcula el total', () => {`,
);

const packageBefore = `{
  "name": "tienda-online",
  "private": true,
  "version": "0.4.2",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
`;
const packageAfter = packageBefore.replace('"version": "0.4.2"', '"version": "0.4.3"');

const TIENDA_FILES = {
  'package.json': packageBefore
    .replace('"vite": "^5.4.8"', '"vite": "^5.3.5"')
    .replace('"vitest": "^2.1.2"', '"vitest": "^1.6.0"'),
  'README.md': `# Tienda online

Catalogo, carrito y checkout de la tienda. React + Vite, con Vitest para los tests.

\`\`\`
npm install
npm run dev
\`\`\`
`,
  '.gitignore': 'node_modules/\ndist/\n.env\n',
  'index.html': `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Tienda</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom' },
});
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
`,
  'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  'src/App.tsx': `import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { CartProvider } from './cart/CartProvider';
import { ProductList } from './catalog/ProductList';
import { Checkout } from './checkout/Checkout';

export function App() {
  return (
    <CartProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProductList />} />
          <Route path="/checkout" element={<Checkout />} />
        </Routes>
      </BrowserRouter>
    </CartProvider>
  );
}
`,
  'src/cart/types.ts': `export interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}
`,
  'src/cart/CartProvider.tsx': cartProviderBefore,
  'src/cart/useCart.ts': useCartBefore,
  'src/catalog/ProductList.tsx': `import { useEffect, useState } from 'react';
import { fetchProducts, type Product } from '../api/client';
import { useCart } from '../cart/useCart';
import { byCategory, type Category } from './filters';

export function ProductList() {
  const [products, setProducts] = useState<Product[]>([]);
  const [category, setCategory] = useState<Category | 'todas'>('todas');
  const { add } = useCart();

  useEffect(() => {
    void fetchProducts().then(setProducts);
  }, []);

  const visible = category === 'todas' ? products : products.filter(byCategory(category));

  return (
    <main>
      <select value={category} onChange={(event) => setCategory(event.target.value as Category)}>
        <option value="todas">Todas</option>
        <option value="ropa">Ropa</option>
        <option value="calzado">Calzado</option>
        <option value="accesorios">Accesorios</option>
      </select>
      <ul>
        {visible.map((product) => (
          <li key={product.id}>
            {product.name} — S/ {product.price.toFixed(2)}
            <button onClick={() => add({ productId: product.id, name: product.name, price: product.price, quantity: 1 })}>
              Agregar
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
  'src/catalog/filters.ts': `import type { Product } from '../api/client';

export type Category = 'ropa' | 'calzado' | 'accesorios';

export function byCategory(category: Category) {
  return (product: Product) => product.category === category;
}

export function featured(products: Product[]): Product[] {
  return products.filter((product) => product.featured).slice(0, 8);
}
`,
  'src/checkout/Checkout.tsx': `import { useState } from 'react';
import { createOrder } from '../api/client';
import { useCart } from '../cart/useCart';

export function Checkout() {
  const { items, total, clear } = useCart();
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');

  async function confirm() {
    setStatus('sending');
    await createOrder(items);
    clear();
    setStatus('done');
  }

  if (status === 'done') return <p>Pedido confirmado. Te llega un correo con el detalle.</p>;

  return (
    <section>
      <h1>Tu pedido</h1>
      <ul>
        {items.map((item) => (
          <li key={item.productId}>
            {item.quantity} × {item.name}
          </li>
        ))}
      </ul>
      <p>Total: S/ {total.toFixed(2)}</p>
      <button disabled={items.length === 0 || status === 'sending'} onClick={() => void confirm()}>
        Confirmar
      </button>
    </section>
  );
}
`,
  'src/api/client.ts': `import type { CartItem } from '../cart/types';

export interface Product {
  id: string;
  name: string;
  price: number;
  category: 'ropa' | 'calzado' | 'accesorios';
  featured: boolean;
}

const BASE = import.meta.env.VITE_API_URL ?? '/api';

export async function fetchProducts(): Promise<Product[]> {
  const response = await fetch(\`\${BASE}/products\`);
  if (!response.ok) throw new Error(\`No se pudo cargar el catalogo (\${response.status})\`);
  return (await response.json()) as Product[];
}

export async function createOrder(items: CartItem[]): Promise<{ orderId: string }> {
  const response = await fetch(\`\${BASE}/orders\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(\`El pedido no se pudo crear (\${response.status})\`);
  return (await response.json()) as { orderId: string };
}
`,
  'tests/cart.test.ts': cartTestBefore,
};

const FILTERS_WITH_COMMENT = {
  'src/catalog/filters.ts': `import type { Product } from '../api/client';

export type Category = 'ropa' | 'calzado' | 'accesorios';

export function byCategory(category: Category) {
  return (product: Product) => product.category === category;
}

/** Los destacados van primero y se limitan a ocho: es lo que entra en la portada. */
export function featured(products: Product[]): Product[] {
  return products.filter((product) => product.featured).slice(0, 8);
}
`,
};

const WORKTREE_FILES = {
  'src/cart/CartProvider.tsx': cartProviderAfter,
  'src/cart/useCart.ts': useCartAfter,
  'package.json': packageAfter,
  'src/cart/storage.ts': `import type { CartItem } from './types';

const STORAGE_KEY = 'tienda.cart';

/** Lo guardado, o un carrito vacio si no hay nada o no se puede leer. */
export function loadCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCartItem) : [];
  } catch {
    return [];
  }
}

export function saveCart(items: CartItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sin almacenamiento (modo privado, cuota llena): el carrito vive en memoria.
  }
}

function isCartItem(value: unknown): value is CartItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['productId'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['price'] === 'number' &&
    typeof record['quantity'] === 'number'
  );
}
`,
  'docs/decisiones.md': `# Decisiones

## El carrito vive en localStorage

Se guarda con la clave \`tienda.cart\`. Un valor corrupto se descarta en silencio:
un carrito vacio es mejor que una pantalla en blanco.
`,
};

function simpleProject(ctx, name, readme, files = {}) {
  const dir = path.join(ctx.projectsDir, name);
  mkdirSync(dir, { recursive: true });
  write(dir, { 'README.md': readme, '.gitignore': 'node_modules/\nbin/\nobj/\n', ...files });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'chore: estructura inicial', ctx.now - 20 * DAY);
  return dir;
}

// ---------------------------------------------------------------------------
// Sesiones JSONL
// ---------------------------------------------------------------------------
const MODEL = 'claude-opus-5';
const MODEL_VARIANT = 'claude-opus-5[1m]';

function slugFor(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * steps:
 *   { u: 'texto' }                                  mensaje del usuario
 *   { a: 'texto' }                                  respuesta con texto
 *   { tool: 'Read', input: {...}, result: '...' }   llamada + resultado
 *   { ask: { question, header, options } }          AskUserQuestion sin contestar
 *   { turn: ms }                                    turn_duration del ultimo assistant
 */
function session(ctx, { cwd, branch, startAt, title, steps, effort = 'xhigh', contextStart = 18_400 }) {
  const sessionId = randomUUID();
  const lines = [];
  let at = startAt;
  let parent = null;
  let lastAssistant = null;
  let context = contextStart;
  let totalOut = 0;

  const base = (extra) => ({
    ...extra,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: CLI_VERSION,
    gitBranch: branch,
  });

  const tick = (ms) => {
    at += ms;
    return new Date(at).toISOString();
  };

  const usage = (out) => {
    const creation = 900 + Math.floor(Math.random() * 2600);
    const record = {
      input_tokens: 4 + Math.floor(Math.random() * 30),
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: context,
      output_tokens: out,
      service_tier: 'standard',
    };
    context += creation + out;
    totalOut += out;
    return record;
  };

  const assistant = (content, out) => {
    const uuid = randomUUID();
    lines.push({
      parentUuid: parent,
      isSidechain: false,
      message: {
        model: MODEL,
        id: `msg_${uuid.replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: usage(out),
      },
      requestId: `req_${uuid.replace(/-/g, '').slice(0, 24)}`,
      type: 'assistant',
      uuid,
      timestamp: tick(2_000 + Math.floor(Math.random() * 9_000)),
      effort,
      ...base({}),
    });
    parent = uuid;
    lastAssistant = uuid;
  };

  lines.push({ type: 'permission-mode', permissionMode: 'auto', sessionId });
  if (title !== undefined) lines.push({ type: 'ai-title', aiTitle: title, sessionId });

  for (const step of steps) {
    if (step.u !== undefined) {
      const uuid = randomUUID();
      lines.push({
        parentUuid: parent,
        isSidechain: false,
        promptId: randomUUID(),
        type: 'user',
        message: { role: 'user', content: step.u },
        uuid,
        timestamp: tick(parent === null ? 0 : 40_000 + Math.floor(Math.random() * 120_000)),
        permissionMode: 'auto',
        promptSource: 'cli',
        ...base({}),
      });
      parent = uuid;
    } else if (step.a !== undefined) {
      assistant([{ type: 'text', text: step.a }], Math.max(40, Math.round(step.a.length / 3.6)));
    } else if (step.tool !== undefined) {
      const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      assistant(
        [{ type: 'tool_use', id: toolUseId, name: step.tool, input: step.input }],
        60 + Math.round(JSON.stringify(step.input).length / 3.6),
      );
      const uuid = randomUUID();
      const resultText = step.result ?? '';
      lines.push({
        parentUuid: parent,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: toolUseId, type: 'tool_result', content: resultText, is_error: false }],
        },
        uuid,
        timestamp: tick(300 + Math.floor(Math.random() * 3_000)),
        toolUseResult:
          step.tool === 'Bash'
            ? { stdout: resultText, stderr: '', interrupted: false, isImage: false }
            : undefined,
        sourceToolAssistantUUID: parent,
        ...base({}),
      });
      parent = uuid;
    } else if (step.ask !== undefined) {
      const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      assistant(
        [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions: [step.ask] } }],
        160,
      );
    } else if (step.turn !== undefined) {
      lines.push({
        parentUuid: lastAssistant,
        isSidechain: false,
        type: 'system',
        subtype: 'turn_duration',
        durationMs: step.turn,
        timestamp: tick(50),
        uuid: randomUUID(),
        isMeta: false,
        ...base({}),
      });
    }
  }

  lines.push({
    type: 'cost-state',
    sessionId,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: at - startAt,
    startTime: startAt,
    modelUsage: {
      [MODEL_VARIANT]: {
        inputTokens: 120,
        outputTokens: totalOut,
        thinkingTokens: 0,
        cacheReadInputTokens: context,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      },
    },
    hasUnknownModelCost: false,
  });

  const dir = path.join(ctx.home, '.claude', 'projects', slugFor(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const mtime = new Date(at);
  utimesSync(file, mtime, mtime);
  return { sessionId, cwd, title: title ?? steps[0].u };
}

// Conversaciones cortas, para llenar la barra lateral.
function quick(ctx, cwd, branch, ago, prompt, answer, title) {
  return session(ctx, {
    cwd,
    branch,
    startAt: ctx.now - ago,
    title,
    steps: [{ u: prompt }, { a: answer }, { turn: 30_000 + Math.floor(Math.random() * 200_000) }],
  });
}

/** La conversacion que se ve en la captura principal. */
const MAIN_STEPS = [
  { u: 'Antes de tocar nada: contame como esta organizado el carrito y que tests tiene.' },
  {
    tool: 'Read',
    input: { file_path: 'src/cart/CartProvider.tsx' },
    result: cartProviderBefore
      .split('\n')
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join('\n'),
  },
  {
    tool: 'Read',
    input: { file_path: 'tests/cart.test.ts' },
    result: cartTestBefore
      .split('\n')
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join('\n'),
  },
  {
    a: `El carrito son tres archivos en \`src/cart/\`:

- **\`CartProvider.tsx\`** — el estado. Un \`useState\` con la lista de items y un contexto que expone \`add\`, \`remove\`, \`clear\` y \`total\`.
- **\`useCart.ts\`** — el hook que consumen el catálogo y el checkout.
- **\`types.ts\`** — \`CartItem\`: \`productId\`, \`name\`, \`price\`, \`quantity\`.

Los tests están en \`tests/cart.test.ts\` y son tres: agregar un producto, sumar cantidades del mismo producto y calcular el total. Ninguno cubre lo que pasa al recargar la página.`,
  },
  { turn: 48_310 },
  {
    u: 'El carrito se vacía cuando el usuario recarga la página. Revisá `src/cart/` y arreglalo: los productos tienen que sobrevivir a la recarga.',
  },
  { a: 'Voy a ver cómo se guarda el estado antes de tocar nada.' },
  {
    tool: 'Grep',
    input: { pattern: 'localStorage|sessionStorage', path: 'src' },
    result: "src/cart/CartProvider.tsx:18:    localStorage.setItem('cart', JSON.stringify(items));",
  },
  {
    tool: 'Grep',
    input: { pattern: 'CartProvider', glob: 'src/**/*.tsx' },
    result: 'src/App.tsx:2:import { CartProvider } from \'./cart/CartProvider\';\nsrc/App.tsx:8:    <CartProvider>\nsrc/App.tsx:15:    </CartProvider>',
  },
  {
    tool: 'Read',
    input: { file_path: 'src/cart/useCart.ts' },
    result: useCartBefore
      .split('\n')
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join('\n'),
  },
  {
    tool: 'Read',
    input: { file_path: 'src/App.tsx' },
    result: '     1\timport { BrowserRouter, Route, Routes } from \'react-router-dom\';\n     2\timport { CartProvider } from \'./cart/CartProvider\';\n     3\t…',
  },
  {
    tool: 'Read',
    input: { file_path: 'src/checkout/Checkout.tsx' },
    result: '     1\timport { useState } from \'react\';\n     2\timport { createOrder } from \'../api/client\';\n     3\t…',
  },
  {
    a: `Encontré la causa. \`CartProvider\` escribe en \`localStorage\` cada vez que cambia el carrito, pero el estado inicial es \`[]\`: al recargar, el primer render **pisa lo guardado con un carrito vacío** antes de haberlo leído.

\`\`\`tsx
const [items, setItems] = useState<CartItem[]>([]);

useEffect(() => {
localStorage.setItem('cart', JSON.stringify(items));
}, [items]);
\`\`\`

El arreglo es leer el valor guardado en el inicializador de \`useState\`, y mover la lectura y la escritura a un módulo aparte para que el proveedor no sepa nada de \`localStorage\`. Un valor corrupto se descarta en silencio: un carrito vacío es mejor que una pantalla en blanco.`,
  },
  {
    tool: 'Write',
    input: {
      file_path: 'src/cart/storage.ts',
      content: "import type { CartItem } from './types';\n\nconst STORAGE_KEY = 'tienda.cart';\n\nexport function loadCart(): CartItem[] {\n  …\n}\n",
    },
    result: 'File created successfully at: src/cart/storage.ts',
  },
  {
    tool: 'Edit',
    input: {
      file_path: 'src/cart/CartProvider.tsx',
      old_string: '  const [items, setItems] = useState<CartItem[]>([]);',
      new_string: '  const [items, setItems] = useState<CartItem[]>(() => loadCart());',
    },
    result: 'The file src/cart/CartProvider.tsx has been updated successfully.',
  },
  {
    tool: 'Edit',
    input: {
      file_path: 'tests/cart.test.ts',
      old_string: "  it('calcula el total', () => {",
      new_string: "  it('sobrevive a una recarga', () => {\n    …\n  });\n\n  it('calcula el total', () => {",
    },
    result: 'The file tests/cart.test.ts has been updated successfully.',
  },
  {
    tool: 'Bash',
    input: { command: 'npm test -- cart', description: 'Correr los tests del carrito' },
    result: `> tienda-online@0.4.3 test
> vitest run cart

 ✓ tests/cart.test.ts (5 tests) 212ms

 Test Files  1 passed (1)
    Tests  5 passed (5)
 Duration  1.94s`,
  },
  {
    a: `Listo. Los cinco tests del carrito pasan, incluidos dos nuevos: uno desmonta el proveedor, lo vuelve a montar y comprueba que los productos siguen ahí; el otro guarda basura en \`localStorage\` y espera un carrito vacío en vez de una excepción.

Qué cambió:

- \`src/cart/storage.ts\` (nuevo): \`loadCart()\` y \`saveCart()\`, con la clave \`tienda.cart\`.
- \`src/cart/CartProvider.tsx\`: el estado arranca con \`loadCart()\` en vez de \`[]\`.
- \`tests/cart.test.ts\`: los dos casos de arriba.

Una decisión antes de cerrar:`,
  },
  {
    ask: {
      question: '¿El carrito tiene que sobrevivir también al cerrar el navegador, o solo a la recarga?',
      header: 'Persistencia',
      multiSelect: false,
      options: [
        {
          label: 'También al cerrar el navegador',
          description: 'localStorage: el carrito queda hasta que el usuario lo vacíe o compre.',
        },
        {
          label: 'Solo a la recarga',
          description: 'sessionStorage: se pierde al cerrar la pestaña. Más privado en una computadora compartida.',
        },
      ],
    },
  },
];

/**
 * @param {{ root: string, home: string, bin: string, configDir: string, projectsRoot: string }} dirs
 *   `projectsRoot` es la ruta con la que la app va a ver `<root>/Proyectos`
 *   (`W:\Proyectos` en Windows), y es la que se escribe en el `cwd` del JSONL.
 *   `configDir` es donde la app busca `workspace.json` con ese `home`.
 * @returns {{ mainCwd: string, tabs: Array<{cwd: string, sessionId: string, label: string}> }}
 */
/**
 * Un plan del modo plan, para la solapa "Planes".
 *
 * La CLI escribe estos archivos en `~/.claude/plans/` y los nombra en el JSONL;
 * el panel lista los de la sesion que se esta mirando. Sin uno en los datos de
 * demo, la solapa sale siempre vacia.
 */
const DEMO_PLAN_FILE = 'carrito-persistente-storage.md';
const DEMO_PLAN = `# Plan: que el carrito sobreviva a la recarga

## Contexto

El carrito vive solo en memoria (\`useState\` en \`CartProvider\`), asi que una
recarga lo vacia. Paso en produccion con un carrito de nueve productos y el
usuario lo reporto como "se borro solo".

## Que se toca

| Archivo | Cambio |
|---|---|
| \`src/cart/CartProvider.tsx\` | leer el estado inicial de \`localStorage\` |
| \`src/cart/storage.ts\` | nuevo: leer, escribir y validar lo guardado |
| \`tests/cart.test.ts\` | dos casos: recarga con items y storage corrupto |

## Decisiones

- **\`localStorage\` y no una cookie.** El carrito no viaja al servidor en cada
  peticion y son varios KB; una cookie los mandaria en todas.
- **Lo guardado se valida al leer.** Un carrito de una version anterior —o
  editado a mano— no puede romper la portada: si no tiene la forma esperada,
  se descarta y se arranca vacio.
- **Se guarda el id y la cantidad, no el producto entero.** El precio y el stock
  se piden de nuevo al cargar: guardarlos deja al usuario mirando un precio que
  ya no existe.

## Lo que queda afuera

Sincronizar el carrito entre dispositivos. Eso necesita cuenta de usuario y es
otro trabajo.
`;

export function buildFixtures(dirs) {
  const root = dirs.root;
  const home = dirs.home;
  const bin = dirs.bin;
  const now = Date.now();
  const projectsDir = path.join(root, 'Proyectos');
  const ctx = { home, now, projectsDir };

  for (const dir of [root, home, bin]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  mkdirSync(dirs.configDir, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // CLI simulada.
  writeFileSync(
    path.join(bin, 'claude'),
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${CLI_VERSION} (Claude Code)"; exit 0; fi`,
      'echo',
      'echo "  Demo: esta pestana no lanza ningun agente. Solo sirve para las capturas."',
      'echo',
      'exec "${SHELL:-/bin/sh}" -i',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'claude'), 0o755);
  writeFileSync(
    path.join(bin, 'claude.cmd'),
    [
      '@echo off',
      `if "%~1"=="--version" (echo ${CLI_VERSION} ^(Claude Code^)& exit /b 0)`,
      'echo.',
      'echo   Demo: esta pestana no lanza ningun agente. Solo sirve para las capturas.',
      'echo.',
      'cmd /k "prompt $G$S"',
      '',
    ].join('\r\n'),
  );

  // tienda-online: el proyecto que se ve en los paneles.
  const tienda = path.join(projectsDir, 'tienda-online');
  mkdirSync(tienda, { recursive: true });
  write(tienda, TIENDA_FILES);
  git(tienda, 'init', '-q', '-b', 'main');
  commit(tienda, 'feat: catalogo con filtro por categoria', now - 9 * DAY);
  write(tienda, FILTERS_WITH_COMMENT);
  commit(tienda, 'perf: los destacados se limitan a ocho en la portada', now - 6 * DAY);
  write(tienda, { 'package.json': packageBefore });
  commit(tienda, 'chore: actualizar vite y vitest', now - 3 * DAY);
  git(tienda, 'checkout', '-q', '-b', 'feat/carrito-persistente');
  // Estado del arbol de trabajo: un archivo preparado, dos sin preparar, dos sin seguimiento.
  write(tienda, { 'tests/cart.test.ts': cartTestAfter });
  git(tienda, 'add', 'tests/cart.test.ts');
  write(tienda, WORKTREE_FILES);

  // El resto: solo para que la barra lateral tenga con que llenarse.
  simpleProject(ctx, 'api-facturacion', '# API de facturacion\n\nEmision de comprobantes electronicos.\n', {
    'src/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.MapControllers();\napp.Run();\n',
  });
  simpleProject(ctx, 'portal-clientes', '# Portal de clientes\n\nAutoservicio: estados de cuenta, tickets y datos de contacto.\n');
  simpleProject(ctx, 'app-reservas', '# App de reservas\n\nReserva de salas y recordatorios.\n');
  simpleProject(ctx, 'inventario', '# Inventario\n\nStock, movimientos y valorizacion.\n', {
    'src/importar.py': 'import openpyxl\n\n\ndef leer_planilla(ruta: str) -> list[dict]:\n    libro = openpyxl.load_workbook(ruta, read_only=True)\n    hoja = libro.active\n    filas = hoja.iter_rows(min_row=2, values_only=True)\n    return [{"sku": f[0], "cantidad": f[1]} for f in filas if f[0]]\n',
  });
  simpleProject(ctx, 'dashboard-ventas', '# Dashboard de ventas\n\nGraficos mensuales y comparacion anual.\n');

  const TIENDA = path.join(dirs.projectsRoot, 'tienda-online');
  const FACTURACION = path.join(dirs.projectsRoot, 'api-facturacion');
  const PORTAL = path.join(dirs.projectsRoot, 'portal-clientes');
  const RESERVAS = path.join(dirs.projectsRoot, 'app-reservas');
  const INVENTARIO = path.join(dirs.projectsRoot, 'inventario');
  const DASHBOARD = path.join(dirs.projectsRoot, 'dashboard-ventas');

  // La conversacion principal.
  const main = session(ctx, {
    cwd: TIENDA,
    branch: 'feat/carrito-persistente',
    startAt: now - 34 * MIN,
    title: 'El carrito pierde los productos al recargar',
    contextStart: 21_300,
    steps: MAIN_STEPS,
  });

  /*
    El plan de esa conversacion. Dos cosas: el archivo en la carpeta de planes
    de la CLI, y la linea del JSONL que lo nombra — que es como el panel sabe
    que este plan es de esta sesion y no de otra.
  */
  mkdirSync(path.join(home, '.claude', 'plans'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'plans', DEMO_PLAN_FILE), DEMO_PLAN);
  appendFileSync(
    path.join(home, '.claude', 'projects', slugFor(main.cwd), `${main.sessionId}.jsonl`),
    `${JSON.stringify({
      type: 'attachment',
      uuid: 'plan-1',
      parentUuid: null,
      timestamp: new Date(now - 30 * MIN).toISOString(),
      attachment: {
        type: 'plan_mode_exit',
        planFilePath: path.join(home, '.claude', 'plans', DEMO_PLAN_FILE),
        planExists: true,
      },
      sessionId: main.sessionId,
      cwd: main.cwd,
    })}\n`,
  );

  // --- El resto de tienda-online ----------------------------------------------
  quick(ctx, TIENDA, 'main', 2 * DAY + 3 * HOUR, 'Agregá un filtro por categoría al catálogo, arriba de la lista.', 'Agregué el `<select>` con las tres categorías en `ProductList.tsx` y la función `byCategory` en `filters.ts`. El filtro se aplica en memoria sobre lo que ya bajó del API.');
  quick(ctx, TIENDA, 'feat/pasarela', 3 * DAY + 5 * HOUR, 'Migrá el checkout a la nueva pasarela de pagos. La documentación está en docs/pasarela.md.', 'Reemplacé el cliente viejo por `PaymentGateway` y dejé el anterior detrás de una variable de entorno para poder volver atrás. Falta probar contra el sandbox con tarjeta real.');
  quick(ctx, TIENDA, 'main', 5 * DAY + HOUR, 'Escribí tests para el servicio de cupones: porcentaje, monto fijo y cupón vencido.', 'Cinco tests en `tests/coupons.test.ts`. El de cupón vencido encontró un bug: se comparaba la fecha como string.');
  quick(ctx, TIENDA, 'main', 6 * DAY + 7 * HOUR, 'La consulta de productos destacados tarda dos segundos en la portada. ¿Qué pasa?', 'Se traía el catálogo entero y se filtraba en el navegador. Ahora el API expone `/products?featured=1` y la portada pide solo eso: de 2,1 s a 140 ms.');
  quick(ctx, TIENDA, 'main', 8 * DAY + 2 * HOUR, 'Revisá la accesibilidad del formulario de registro.', 'Tres problemas: campos sin `label`, error de validación que no se anuncia y contraste insuficiente en el botón deshabilitado. Los tres arreglados.');
  quick(ctx, TIENDA, 'main', 12 * DAY + 4 * HOUR, 'Actualizá las dependencias y arreglá el build.', 'Vite 5.4 y Vitest 2.1. El build rompía por un `import.meta.env` tipado con `any`; quedó declarado en `vite-env.d.ts`.');

  // --- api-facturacion --------------------------------------------------------
  const facturacionTab = quick(ctx, FACTURACION, 'main', 62 * MIN, 'Validá el RUC antes de emitir el comprobante: once dígitos y dígito verificador.', 'Agregué `RucValidator` con el algoritmo del módulo 11 y doce casos de prueba, incluidos RUC de persona natural (10) y de empresa (20).');
  quick(ctx, FACTURACION, 'main', DAY + 6 * HOUR, 'Generá el PDF de la factura con el logo del cliente arriba a la izquierda.', 'El logo se lee de `clientes.logo_path` y se escala a 140 px de ancho. Si no hay logo, el espacio se deja en blanco para que la numeración no se mueva.');
  quick(ctx, FACTURACION, 'main', 4 * DAY + 3 * HOUR, 'Cuando SUNAT no responde, el envío falla y no se reintenta. Implementá reintentos con espera exponencial.', 'Tres reintentos: 2, 8 y 32 segundos. Después de eso el comprobante queda en estado `pendiente` y lo levanta el job de la noche.');
  quick(ctx, FACTURACION, 'main', 9 * DAY + HOUR, 'La numeración correlativa se repite cuando dos facturas se emiten al mismo tiempo.', 'Era una lectura y escritura sin transacción. Ahora el correlativo se toma con `UPDATE … OUTPUT` en una sola sentencia.');

  // --- portal-clientes --------------------------------------------------------
  quick(ctx, PORTAL, 'main', 3 * HOUR + 12 * MIN, 'Implementá el login con código de un solo uso enviado por correo.', 'Código de seis dígitos, válido diez minutos, un solo intento por minuto. La plantilla del correo está en `templates/login-code.html`.');
  quick(ctx, PORTAL, 'main', 2 * DAY + 2 * HOUR, 'Los estados de cuenta tienen que poder descargarse en PDF desde el portal.', 'Nuevo endpoint `GET /cuentas/:id/estado.pdf`. Se genera al vuelo y se cachea una hora por cliente.');
  quick(ctx, PORTAL, 'main', 7 * DAY + 5 * HOUR, 'Armá el panel de tickets de soporte: lista, filtro por estado y detalle.', 'Tres vistas y el filtro en la URL para que se pueda compartir el enlace. Falta el adjunto de archivos, que depende del almacenamiento nuevo.');

  // --- app-reservas -----------------------------------------------------------
  quick(ctx, RESERVAS, 'main', DAY + 4 * HOUR, 'Mostrá un calendario con la disponibilidad de cada sala.', 'Vista semanal con una columna por sala. Los bloques ocupados salen del API y los libres se calculan en el cliente.');
  quick(ctx, RESERVAS, 'main', 5 * DAY + 2 * HOUR, 'Mandá un recordatorio por WhatsApp un día antes de cada reserva.', 'Job diario a las 9:00 que busca las reservas de mañana y las manda por la plantilla aprobada. Se registra cada envío para no repetirlo.');

  // --- inventario -------------------------------------------------------------
  const inventarioTab = quick(ctx, INVENTARIO, 'main', 47 * MIN, 'Importá el stock desde una planilla de Excel. La primera fila son los encabezados.', 'Lectura con `openpyxl` en `importar.py`. Se valida que el SKU exista antes de tocar el stock y se muestra un resumen de filas leídas, aplicadas y rechazadas.');
  quick(ctx, INVENTARIO, 'main', 2 * DAY + 5 * HOUR, 'Alertas por correo cuando un producto baja del stock mínimo.', 'Se dispara al confirmar cada salida. Una alerta por producto por día, para no llenar la casilla.');
  quick(ctx, INVENTARIO, 'main', 4 * DAY + HOUR, 'Historial de movimientos por producto, con filtro por fechas.', 'Tabla paginada sobre `movimientos`, con índice nuevo por `(producto_id, fecha)`. La consulta bajó de 900 ms a 30 ms.');
  quick(ctx, INVENTARIO, 'main', 6 * DAY + 3 * HOUR, 'Imprimí el código de barras en la etiqueta del producto.', 'Code 128 con `python-barcode`, en la esquina inferior de la etiqueta de 50×30 mm.');
  quick(ctx, INVENTARIO, 'main', 10 * DAY + 2 * HOUR, 'Reporte de valorización del inventario a una fecha.', 'Costo promedio ponderado a la fecha elegida. Se exporta a Excel con una hoja por almacén.');

  // --- dashboard-ventas -------------------------------------------------------
  quick(ctx, DASHBOARD, 'main', 3 * DAY + 6 * HOUR, 'Gráfico de ventas por mes con la comparación contra el año anterior.', 'Barras del año actual y línea del anterior, con el mismo eje. Los meses sin datos se dibujan en cero en vez de saltearse.');

  // Pestanas abiertas al arrancar.
  const tabs = [
    { cwd: main.cwd, sessionId: main.sessionId, label: main.title },
    { cwd: facturacionTab.cwd, sessionId: facturacionTab.sessionId, label: 'Validar el RUC antes de emitir' },
    { cwd: inventarioTab.cwd, sessionId: inventarioTab.sessionId, label: 'Importar stock desde Excel' },
  ];
  writeFileSync(
    path.join(dirs.configDir, 'workspace.json'),
    JSON.stringify({ version: 1, tabs }, null, 2),
  );

  return { mainCwd: TIENDA, tabs };
}
