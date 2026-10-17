import type { Product, Stock, Scan } from '../src/types.js';
export const stock = (n: number): Stock => ({
  kind: 'exact',
  quantity: n,
  status: n === 0 ? 'out' : n <= 5 ? 'low' : 'in',
});
export function product(n = 5, id = '1'): Product {
  return {
    id,
    slug: `product-${id}`,
    name: `商品 ${id}`,
    categoryId: '1',
    categoryName: '测试',
    price: '20.00',
    priceFrom: false,
    stock: stock(n),
    skus: [{ id: `${id}1`, name: '默认规格', price: '20.00', stock: stock(n) }],
  };
}
export function rawProduct(n = 5, id = 1) {
  return {
    id,
    slug: `product-${id}`,
    title: { 'zh-CN': `商品 ${id}` },
    category_id: 1,
    category: { name: { 'zh-CN': '测试' } },
    price_amount: '20.00',
    fulfillment_type: 'auto',
    auto_stock_available: n,
    stock_status: n === 0 ? 'out_of_stock' : 'in_stock',
    stock_display_mode: 'exact',
    stock_quantity_hidden: false,
    skus: [
      {
        id: id * 10 + 1,
        is_active: true,
        sku_code: 'DEFAULT',
        spec_values: {},
        price_amount: '20.00',
        auto_stock_available: n,
        stock_status: n === 0 ? 'out_of_stock' : 'in_stock',
      },
    ],
  };
}
export function scan(products: Product[], at = Date.now()): Scan {
  return { products, at, siteName: '测试店铺', currency: 'CNY', pages: 1 };
}
