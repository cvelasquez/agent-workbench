/**
 * Datos ficticios para `pnpm demo` y `pnpm demo:shots`.
 *
 * Genera, en una carpeta temporal, todo lo que la app lee de la maquina:
 *
 *   <root>/Projects/<nombre>        proyectos inventados; uno con git y cambios
 *   <home>/.claude/projects/<slug>  sesiones JSONL sinteticas, con el esquema real,
 *                                   y la memoria nativa de un proyecto
 *   <home>/.codex, .local/share/opencode, .gemini/antigravity-cli
 *                                   historiales de las otras tres CLIs (other-clis.mjs)
 *   <configDir>/workspace.json      cuatro pestanas guardadas, una por CLI
 *   <bin>/claude, codex, opencode, agy (+ .cmd)
 *                                   CLIs simuladas: contestan --version y se quedan
 *
 * Los nombres son inventados a proposito: las capturas del README son publicas
 * y no pueden mostrar proyectos reales. Ninguna ruta lleva el usuario de la
 * maquina: en Windows la carpeta se monta como unidad `W:` (ver environment.mjs).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOtherClis } from './other-clis.mjs';

const CLI_VERSION = '2.1.270';
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
  // Sin la salida de git: los avisos de fin de linea de Windows llenaban la de la demo.
  execFileSync('git', ['add', '-A'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
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
// online-store: contenido de los archivos
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
    `  // Read once, in the initializer. If the state started out as [], the
  // first effect would overwrite what was saved before reading it: that was
  // the bug that emptied the cart on every reload.
  const [items, setItems] = useState<CartItem[]>(() => loadCart());

  useEffect(() => {
    saveCart(items);
  }, [items]);`,
  );

const useCartBefore = `import { useContext } from 'react';
import { CartContext } from './CartProvider';

export function useCart() {
  const context = useContext(CartContext);
  if (context === null) throw new Error('useCart needs a CartProvider');
  return context;
}
`;

const useCartAfter = `import { useContext } from 'react';
import { CartContext } from './CartProvider';

export function useCart() {
  const context = useContext(CartContext);
  if (context === null) {
    throw new Error('useCart was called outside <CartProvider>. Wrap the app in App.tsx.');
  }
  return context;
}

/** Total number of units, for the badge on the cart icon. */
export function useCartCount(): number {
  const { items } = useCart();
  return items.reduce((sum, entry) => sum + entry.quantity, 0);
}
`;

const cartTestBefore = `import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CartProvider } from '../src/cart/CartProvider';
import { useCart } from '../src/cart/useCart';

const hoodie = { productId: 'p-101', name: 'Gray hoodie', price: 59.9, quantity: 1 };

describe('cart', () => {
  it('adds a product', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add(hoodie));
    expect(result.current.items).toHaveLength(1);
  });

  it('adds up quantities of the same product', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add(hoodie));
    act(() => result.current.add({ ...hoodie, quantity: 2 }));
    expect(result.current.items[0]?.quantity).toBe(3);
  });

  it('computes the total', () => {
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => result.current.add({ ...hoodie, quantity: 2 }));
    expect(result.current.total).toBeCloseTo(119.8);
  });
});
`;

const cartTestAfter = cartTestBefore.replace(
  `  it('computes the total', () => {`,
  `  it('survives a reload', () => {
    const first = renderHook(() => useCart(), { wrapper: CartProvider });
    act(() => first.result.current.add(hoodie));
    first.unmount();

    const second = renderHook(() => useCart(), { wrapper: CartProvider });
    expect(second.result.current.items).toEqual([hoodie]);
  });

  it('ignores a corrupted saved value', () => {
    localStorage.setItem('store.cart', '{not json');
    const { result } = renderHook(() => useCart(), { wrapper: CartProvider });
    expect(result.current.items).toEqual([]);
  });

  it('computes the total', () => {`,
);

const packageBefore = `{
  "name": "online-store",
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
  'README.md': `# Online store

Catalog, cart and checkout for the store. React + Vite, with Vitest for the tests.

\`\`\`
npm install
npm run dev
\`\`\`
`,
  '.gitignore': 'node_modules/\ndist/\n.env\n',
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Store</title>
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
  const [category, setCategory] = useState<Category | 'all'>('all');
  const { add } = useCart();

  useEffect(() => {
    void fetchProducts().then(setProducts);
  }, []);

  const visible = category === 'all' ? products : products.filter(byCategory(category));

  return (
    <main>
      <select value={category} onChange={(event) => setCategory(event.target.value as Category)}>
        <option value="all">All</option>
        <option value="clothing">Clothing</option>
        <option value="shoes">Shoes</option>
        <option value="accessories">Accessories</option>
      </select>
      <ul>
        {visible.map((product) => (
          <li key={product.id}>
            {product.name} — \${product.price.toFixed(2)}
            <button onClick={() => add({ productId: product.id, name: product.name, price: product.price, quantity: 1 })}>
              Add to cart
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
  'src/catalog/filters.ts': `import type { Product } from '../api/client';

export type Category = 'clothing' | 'shoes' | 'accessories';

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

  if (status === 'done') return <p>Order confirmed. You will get an email with the details.</p>;

  return (
    <section>
      <h1>Your order</h1>
      <ul>
        {items.map((item) => (
          <li key={item.productId}>
            {item.quantity} × {item.name}
          </li>
        ))}
      </ul>
      <p>Total: \${total.toFixed(2)}</p>
      <button disabled={items.length === 0 || status === 'sending'} onClick={() => void confirm()}>
        Place order
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
  category: 'clothing' | 'shoes' | 'accessories';
  featured: boolean;
}

const BASE = import.meta.env.VITE_API_URL ?? '/api';

export async function fetchProducts(): Promise<Product[]> {
  const response = await fetch(\`\${BASE}/products\`);
  if (!response.ok) throw new Error(\`Could not load the catalog (\${response.status})\`);
  return (await response.json()) as Product[];
}

export async function createOrder(items: CartItem[]): Promise<{ orderId: string }> {
  const response = await fetch(\`\${BASE}/orders\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(\`Could not create the order (\${response.status})\`);
  return (await response.json()) as { orderId: string };
}
`,
  'tests/cart.test.ts': cartTestBefore,
};

const FILTERS_WITH_COMMENT = {
  'src/catalog/filters.ts': `import type { Product } from '../api/client';

export type Category = 'clothing' | 'shoes' | 'accessories';

export function byCategory(category: Category) {
  return (product: Product) => product.category === category;
}

/** Featured products go first, capped at eight: that is what fits on the home page. */
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

const STORAGE_KEY = 'store.cart';

/** What was saved, or an empty cart if there is nothing or it cannot be read. */
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
    // No storage (private mode, quota exceeded): the cart lives in memory.
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
  'docs/decisions.md': `# Decisions

## The cart lives in localStorage

It is saved under the \`store.cart\` key. A corrupted value is silently discarded:
an empty cart is better than a blank screen.
`,
};

function simpleProject(ctx, name, readme, files = {}) {
  const dir = path.join(ctx.projectsDir, name);
  mkdirSync(dir, { recursive: true });
  write(dir, { 'README.md': readme, '.gitignore': 'node_modules/\nbin/\nobj/\n', ...files });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'chore: initial project structure', ctx.now - 20 * DAY);
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
  { u: 'Before touching anything: tell me how the cart is organized and what tests it has.' },
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
    a: `The cart is three files in \`src/cart/\`:

- **\`CartProvider.tsx\`** — the state. A \`useState\` with the list of items and a context that exposes \`add\`, \`remove\`, \`clear\` and \`total\`.
- **\`useCart.ts\`** — the hook that the catalog and the checkout consume.
- **\`types.ts\`** — \`CartItem\`: \`productId\`, \`name\`, \`price\`, \`quantity\`.

The tests live in \`tests/cart.test.ts\` and there are three: adding a product, adding up quantities of the same product and computing the total. None of them covers what happens when the page reloads.`,
  },
  { turn: 48_310 },
  {
    u: 'The cart empties when the user reloads the page. Look at `src/cart/` and fix it: the products have to survive a reload.',
  },
  { a: 'Let me check how the state is saved before touching anything.' },
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
    a: `Found the cause. \`CartProvider\` writes to \`localStorage\` every time the cart changes, but the initial state is \`[]\`: on reload, the first render **overwrites what was saved with an empty cart** before it has read it.

\`\`\`tsx
const [items, setItems] = useState<CartItem[]>([]);

useEffect(() => {
localStorage.setItem('cart', JSON.stringify(items));
}, [items]);
\`\`\`

The fix is to read the saved value in the \`useState\` initializer, and to move reading and writing into a separate module so the provider knows nothing about \`localStorage\`. A corrupted value is silently discarded: an empty cart is better than a blank screen.`,
  },
  {
    tool: 'Write',
    input: {
      file_path: 'src/cart/storage.ts',
      content: "import type { CartItem } from './types';\n\nconst STORAGE_KEY = 'store.cart';\n\nexport function loadCart(): CartItem[] {\n  …\n}\n",
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
      old_string: "  it('computes the total', () => {",
      new_string: "  it('survives a reload', () => {\n    …\n  });\n\n  it('computes the total', () => {",
    },
    result: 'The file tests/cart.test.ts has been updated successfully.',
  },
  {
    tool: 'Bash',
    input: { command: 'npm test -- cart', description: 'Run the cart tests' },
    result: `> online-store@0.4.3 test
> vitest run cart

 ✓ tests/cart.test.ts (5 tests) 212ms

 Test Files  1 passed (1)
    Tests  5 passed (5)
 Duration  1.94s`,
  },
  {
    a: `Done. All five cart tests pass, including two new ones: one unmounts the provider, mounts it again and checks that the products are still there; the other saves garbage to \`localStorage\` and expects an empty cart instead of an exception.

What changed:

- \`src/cart/storage.ts\` (new): \`loadCart()\` and \`saveCart()\`, under the \`store.cart\` key.
- \`src/cart/CartProvider.tsx\`: the state starts with \`loadCart()\` instead of \`[]\`.
- \`tests/cart.test.ts\`: the two cases above.

One decision before wrapping up:`,
  },
  {
    ask: {
      question: 'Should the cart also survive closing the browser, or only a reload?',
      header: 'Persistence',
      multiSelect: false,
      options: [
        {
          label: 'Also after closing the browser',
          description: 'localStorage: the cart stays until the user empties it or checks out.',
        },
        {
          label: 'Only across reloads',
          description: 'sessionStorage: it is lost when the tab closes. More private on a shared computer.',
        },
      ],
    },
  },
];

/**
 * Un plan del modo plan, para la solapa "Planes".
 *
 * La CLI escribe estos archivos en `~/.claude/plans/` y los nombra en el JSONL;
 * el panel lista los de la sesion que se esta mirando. Sin uno en los datos de
 * demo, la solapa sale siempre vacia.
 */
const DEMO_PLAN_FILE = 'persistent-cart-storage.md';
const DEMO_PLAN = `# Plan: make the cart survive a reload

## Context

The cart lives only in memory (\`useState\` in \`CartProvider\`), so a reload
empties it. It happened in production with a cart of nine products, and the
user reported it as "it deleted itself".

## What changes

| File | Change |
|---|---|
| \`src/cart/CartProvider.tsx\` | read the initial state from \`localStorage\` |
| \`src/cart/storage.ts\` | new: read, write and validate what was saved |
| \`tests/cart.test.ts\` | two cases: reload with items and corrupted storage |

## Decisions

- **\`localStorage\`, not a cookie.** The cart has no reason to reach the server
  on every request, and it is several KB; a cookie would send it with all of them.
- **What was saved is validated on read.** A cart from an older version —or
  edited by hand— cannot break the home page: if it does not have the expected
  shape, it is discarded and the cart starts empty.
- **Only the id and the quantity are saved, not the whole product.** Price and
  stock are fetched again on load: saving them leaves the user looking at a
  price that no longer exists.

## Out of scope

Syncing the cart across devices. That needs a user account and is a separate
piece of work.
`;

/** La memoria nativa de Claude Code de online-store: dos notas y su indice. */
const NATIVE_MEMORY = {
  'MEMORY.md': `- [Prices in dollars](prices-in-dollars.md) — every price is shown with $ and two decimals
- [Cart tests](cart-tests.md) — run npm test -- cart before touching src/cart
`,
  'prices-in-dollars.md': `---
name: Prices in dollars
description: Every price is shown with $ and two decimals, discounts included
---

The format lives in \`formatPrice\`. A discounted price is rounded before it is
shown: a customer complained about a price of $59.899999.
`,
  'cart-tests.md': `---
name: Cart tests
description: Run npm test -- cart before touching src/cart
---

The cart tests unmount and remount the provider to test a reload. If they fail
after a change in \`storage.ts\`, check the \`store.cart\` key.
`,
};

/**
 * @param {{ root: string, home: string, homeView?: string, bin: string, configDir: string, projectsRoot: string }} dirs
 *   `projectsRoot` es la ruta con la que la app va a ver `<root>/Projects`
 *   (`W:\Projects` en Windows), y es la que se escribe en el `cwd` del JSONL.
 *   `homeView`, lo mismo para el home (`W:\home`): la ruta que se escribe dentro
 *   de los archivos. `configDir` es donde se escribe `workspace.json`.
 * @returns {{ mainCwd: string, tabs: Array<{agent: string, cwd: string, sessionId: string, label: string}> }}
 */
export function buildFixtures(dirs) {
  const root = dirs.root;
  const home = dirs.home;
  const homeView = dirs.homeView ?? dirs.home;
  const bin = dirs.bin;
  const now = Date.now();
  const projectsDir = path.join(root, 'Projects');
  const ctx = { home, now, projectsDir };

  for (const dir of [root, home, bin]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  // El `CODEX_HOME` de la demo: con la variable definida, Codex exige que la
  // carpeta exista aunque todavia no tenga rollouts.
  mkdirSync(path.join(home, '.codex'), { recursive: true });
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

  // online-store: el proyecto que se ve en los paneles.
  const tienda = path.join(projectsDir, 'online-store');
  mkdirSync(tienda, { recursive: true });
  write(tienda, TIENDA_FILES);
  git(tienda, 'init', '-q', '-b', 'main');
  commit(tienda, 'feat: catalog with a category filter', now - 9 * DAY);
  write(tienda, FILTERS_WITH_COMMENT);
  commit(tienda, 'perf: cap featured products at eight on the home page', now - 6 * DAY);
  write(tienda, { 'package.json': packageBefore });
  commit(tienda, 'chore: update vite and vitest', now - 3 * DAY);
  git(tienda, 'checkout', '-q', '-b', 'feat/persistent-cart');
  // Estado del arbol de trabajo: un archivo preparado, dos sin preparar, dos sin seguimiento.
  write(tienda, { 'tests/cart.test.ts': cartTestAfter });
  git(tienda, 'add', 'tests/cart.test.ts');
  write(tienda, WORKTREE_FILES);

  // El resto: solo para que la barra lateral tenga con que llenarse.
  simpleProject(ctx, 'invoicing-api', '# Invoicing API\n\nIssues electronic invoices.\n', {
    'src/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.MapControllers();\napp.Run();\n',
  });
  simpleProject(ctx, 'customer-portal', '# Customer portal\n\nSelf-service: account statements, tickets and contact details.\n');
  simpleProject(ctx, 'booking-app', '# Booking app\n\nRoom bookings and reminders.\n');
  simpleProject(ctx, 'inventory', '# Inventory\n\nStock, movements and valuation.\n', {
    'src/importer.py': 'import openpyxl\n\n\ndef read_sheet(path: str) -> list[dict]:\n    workbook = openpyxl.load_workbook(path, read_only=True)\n    sheet = workbook.active\n    rows = sheet.iter_rows(min_row=2, values_only=True)\n    return [{"sku": r[0], "quantity": r[1]} for r in rows if r[0]]\n',
  });
  simpleProject(ctx, 'sales-dashboard', '# Sales dashboard\n\nMonthly charts and year-over-year comparison.\n');

  const TIENDA = path.join(dirs.projectsRoot, 'online-store');
  const FACTURACION = path.join(dirs.projectsRoot, 'invoicing-api');
  const PORTAL = path.join(dirs.projectsRoot, 'customer-portal');
  const RESERVAS = path.join(dirs.projectsRoot, 'booking-app');
  const INVENTARIO = path.join(dirs.projectsRoot, 'inventory');
  const DASHBOARD = path.join(dirs.projectsRoot, 'sales-dashboard');

  // La conversacion principal.
  const main = session(ctx, {
    cwd: TIENDA,
    branch: 'feat/persistent-cart',
    startAt: now - 34 * MIN,
    title: 'Cart loses its products on reload',
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
  const mainFile = path.join(home, '.claude', 'projects', slugFor(main.cwd), `${main.sessionId}.jsonl`);
  const mainWritten = statSync(mainFile).mtime;
  appendFileSync(
    mainFile,
    `${JSON.stringify({
      type: 'attachment',
      uuid: 'plan-1',
      parentUuid: null,
      timestamp: new Date(now - 30 * MIN).toISOString(),
      attachment: {
        type: 'plan_mode_exit',
        planFilePath: path.join(homeView, '.claude', 'plans', DEMO_PLAN_FILE),
        planExists: true,
      },
      sessionId: main.sessionId,
      cwd: main.cwd,
    })}\n`,
  );
  /*
    Agregar la linea le pone la fecha de ahora al archivo, y una sesion recien
    escrita no esta "en calma": la copia propia la dejaba afuera y el buscador
    de las capturas no la encontraba. Vuelve a la fecha de su ultimo turno.
  */
  utimesSync(mainFile, mainWritten, mainWritten);

  // --- El resto de online-store -----------------------------------------------
  quick(ctx, TIENDA, 'main', 2 * DAY + 3 * HOUR, 'Add a category filter to the catalog, above the list.', 'I added the `<select>` with the three categories in `ProductList.tsx` and the `byCategory` function in `filters.ts`. The filter runs in memory over what the API already returned.');
  quick(ctx, TIENDA, 'feat/payment-gateway', 3 * DAY + 5 * HOUR, 'Move the checkout to the new payment gateway. The docs are in docs/payment-gateway.md.', 'I replaced the old client with `PaymentGateway` and kept the previous one behind an environment variable so we can roll back. It still needs a run against the sandbox with a real card.');
  quick(ctx, TIENDA, 'main', 5 * DAY + HOUR, 'Write tests for the coupon service: percentage, fixed amount and expired coupon.', 'Five tests in `tests/coupons.test.ts`. The expired-coupon one found a bug: the date was compared as a string.');
  quick(ctx, TIENDA, 'main', 6 * DAY + 7 * HOUR, 'The featured products query takes two seconds on the home page. What is going on?', 'It fetched the whole catalog and filtered it in the browser. Now the API exposes `/products?featured=1` and the home page asks only for that: from 2.1 s down to 140 ms.');
  quick(ctx, TIENDA, 'main', 8 * DAY + 2 * HOUR, 'Review the accessibility of the sign-up form.', 'Three problems: fields without a `label`, a validation error that is never announced and poor contrast on the disabled button. All three are fixed.');
  quick(ctx, TIENDA, 'main', 12 * DAY + 4 * HOUR, 'Update the dependencies and fix the build.', 'Vite 5.4 and Vitest 2.1. The build broke on an `import.meta.env` typed as `any`; it is now declared in `vite-env.d.ts`.');

  // --- invoicing-api ----------------------------------------------------------
  quick(ctx, FACTURACION, 'main', DAY + 6 * HOUR, 'Generate the invoice PDF with the customer logo in the top left corner.', 'The logo is read from `customers.logo_path` and scaled to 140 px wide. Without a logo, the space is left blank so the numbering does not move.');
  quick(ctx, FACTURACION, 'main', 4 * DAY + 3 * HOUR, 'When the tax authority API does not respond, the submission fails and is never retried. Add retries with exponential backoff.', 'Three retries: 2, 8 and 32 seconds. After that the invoice stays in the `pending` state and the nightly job picks it up.');
  quick(ctx, FACTURACION, 'main', 9 * DAY + HOUR, 'Invoice numbers repeat when two invoices are issued at the same time.', 'It was a read and a write without a transaction. Now the next number is taken with `UPDATE … OUTPUT` in a single statement.');

  // --- customer-portal --------------------------------------------------------
  quick(ctx, PORTAL, 'main', 3 * HOUR + 12 * MIN, 'Implement login with a one-time code sent by email.', 'A six-digit code, valid for ten minutes, one attempt per minute. The email template is in `templates/login-code.html`.');
  quick(ctx, PORTAL, 'main', 2 * DAY + 2 * HOUR, 'Account statements need to be downloadable as PDF from the portal.', 'New endpoint `GET /accounts/:id/statement.pdf`. It is generated on the fly and cached for an hour per customer.');
  quick(ctx, PORTAL, 'main', 7 * DAY + 5 * HOUR, 'Build the support tickets panel: list, filter by status and detail.', 'Three views, with the filter in the URL so the link can be shared. File attachments are still missing: they depend on the new storage.');

  // --- booking-app ------------------------------------------------------------
  quick(ctx, RESERVAS, 'main', DAY + 4 * HOUR, 'Show a calendar with the availability of each room.', 'Weekly view with one column per room. Booked slots come from the API and free ones are computed on the client.');
  quick(ctx, RESERVAS, 'main', 5 * DAY + 2 * HOUR, 'Send an SMS reminder one day before each booking.', 'A daily job at 9:00 looks up the bookings for tomorrow and sends each reminder with the approved template. Every send is logged so it is never repeated.');

  // --- inventory --------------------------------------------------------------
  quick(ctx, INVENTARIO, 'main', 2 * DAY + 5 * HOUR, 'Email alerts when a product drops below the minimum stock.', 'It fires when each outgoing movement is confirmed. One alert per product per day, so the inbox does not fill up.');
  quick(ctx, INVENTARIO, 'main', 4 * DAY + HOUR, 'Movement history per product, with a date filter.', 'Paginated table over `movements`, with a new index on `(product_id, date)`. The query went from 900 ms to 30 ms.');
  quick(ctx, INVENTARIO, 'main', 6 * DAY + 3 * HOUR, 'Print the barcode on the product label.', 'Code 128 with `python-barcode`, in the bottom corner of the 50×30 mm label.');
  quick(ctx, INVENTARIO, 'main', 10 * DAY + 2 * HOUR, 'Inventory valuation report as of a given date.', 'Weighted average cost as of the chosen date. It exports to Excel with one sheet per warehouse.');

  // --- sales-dashboard --------------------------------------------------------
  quick(ctx, DASHBOARD, 'main', 3 * DAY + 6 * HOUR, 'Monthly sales chart compared against the previous year.', 'Bars for the current year and a line for the previous one, on the same axis. Months without data are drawn at zero instead of being skipped.');

  // --- Las otras tres CLIs, repartidas entre los mismos proyectos -------------
  const { codexTab, openCodeTab, antigravityTab } = buildOtherClis({
    home,
    bin,
    now,
    projects: {
      tienda: TIENDA,
      facturacion: FACTURACION,
      portal: PORTAL,
      reservas: RESERVAS,
      inventario: INVENTARIO,
      dashboard: DASHBOARD,
    },
  });

  /*
    La memoria nativa de online-store, en la carpeta de la CLI: es lo que la
    solapa Memoria ofrece importar al instalar la memoria compartida.
  */
  write(path.join(home, '.claude', 'projects', slugFor(TIENDA), 'memory'), NATIVE_MEMORY);

  /*
    Pestanas guardadas del arranque anterior, una por CLI. Vuelven dormidas: se
    lee su conversacion y ninguna se lanza. Las de Claude Code van en `tabs` y
    las demas en `otherTabs`, con su lugar en la lista (workspace-store.ts).
  */
  const tabs = [
    { agent: 'claude-code', cwd: main.cwd, sessionId: main.sessionId, label: main.title },
    { agent: 'codex', cwd: codexTab.cwd, sessionId: codexTab.sessionId, label: 'Validate the tax ID before issuing' },
    { agent: 'opencode', cwd: openCodeTab.cwd, sessionId: openCodeTab.sessionId, label: 'Import stock from Excel' },
    { agent: 'antigravity', cwd: antigravityTab.cwd, sessionId: antigravityTab.sessionId, label: 'Region filter for sales' },
  ];
  writeFileSync(
    path.join(dirs.configDir, 'workspace.json'),
    JSON.stringify(
      {
        version: 1,
        tabs: tabs
          .filter((tab) => tab.agent === 'claude-code')
          .map(({ cwd, sessionId, label }) => ({ cwd, sessionId, label })),
        otherTabs: tabs.map((tab, position) => ({ position, ...tab })).filter((tab) => tab.agent !== 'claude-code'),
      },
      null,
      2,
    ),
  );

  return { mainCwd: TIENDA, tabs };
}
