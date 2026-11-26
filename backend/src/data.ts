/**
 * Deterministic synthetic order data, so every report does the same amount of real work.
 * A small seeded random generator (mulberry32) gives the same rows on every run.
 */
export interface Order {
  id: number;
  day: number; // 0..89, the last 90 days
  region: string;
  product: string;
  quantity: number;
  amount: number; // in rupees
}

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const PRODUCTS = ['Starter', 'Team', 'Business', 'Enterprise', 'Add-on', 'Support', 'Training', 'Hardware'];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateOrders(count: number, seed = 42): Order[] {
  const random = mulberry32(seed);
  const orders: Order[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const quantity = 1 + Math.floor(random() * 20);
    orders[i] = {
      id: 100000 + i,
      day: Math.floor(random() * 90),
      region: REGIONS[Math.floor(random() * REGIONS.length)],
      product: PRODUCTS[Math.floor(random() * PRODUCTS.length)],
      quantity,
      amount: Math.round(quantity * (199 + random() * 4800)),
    };
  }
  return orders;
}

/** Cheap totals used by the basic summary endpoint. */
export function basicSummary(orders: Order[]) {
  let revenue = 0;
  let units = 0;
  for (const o of orders) {
    revenue += o.amount;
    units += o.quantity;
  }
  return { orders: orders.length, revenue, units, average_order_value: Math.round(revenue / orders.length) };
}
