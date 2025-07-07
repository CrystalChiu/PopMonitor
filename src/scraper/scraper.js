const puppeteer = require('puppeteer');
const Product = require("../database/models/Products");
const PageError = require('../errors/PageError');
const HighTrafficError = require('../errors/HighTrafficError');
const { BASE_URL } = require("../config");

// ENUM for changes that create an alert
const ChangeTypeAlert = Object.freeze({
    RESTOCK: 0,
    NEW_ITEM: 1,
    OTHER: 2,
    SOLD_OUT: 3,
    PRICE_CHANGE: 4
});

const FAIL_THRESHOLD = 0.5;
const PAGE_WAIT_TIMEOUT = 100000;
const PAGE_RETRY_DELAY = 30000;
const MAX_PAGE_FAILS = 3;

let sharedBrowser = null;

async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: false,
      args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--no-sandbox',
          '--no-zygote',
          '--disable-accelerated-2d-canvas',
          '--disable-features=site-per-process',
          '--disable-infobars',
          '--window-size=1920,1080',
      ],
      defaultViewport: null,
    });
  }
  return sharedBrowser;
}

function slugifyTitle(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function scraperInit() {
    console.log("New scrape session started —", new Date().toLocaleString());
    return {
        alertProducts: [],
        changedProductsMap: {},
        pageFails: 0,
        firstPageRetries: 0,
        cache: false,
        allProductsMap: {},
    };
}

function buildBulkOps(productsMap) {
    return Object.values(productsMap).map((product) => ({
      updateOne: {
        filter: { product_id: product.product_id },
        update: {
          $set: {
              name: product.name,
              price: product.price,
              url: product.url,
              in_stock: product.in_stock,
          },
        },
        upsert: true,
      },
    }));
}

async function updateDb(state) {
    const keys = Object.keys(state.changedProductsMap);
    console.log("No. DB Updates Needed:", keys.length);

    if (keys.length > 0) {
        const result = await Product.bulkWrite(buildBulkOps(state.changedProductsMap));
        console.log("Bulk write result:", result);
        state.cache = false;
    } else {
        state.cache = true;
    }
}

function setupPageInterception(page, responseHandler, blockDomains = []) {
    page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      // block unnecessary resources for speed
      const shouldBlock = ['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
        blockDomains.some(domain => req.url().includes(domain));
      shouldBlock ? req.abort() : req.continue();
    });

    if (responseHandler) {
      page.on('response', responseHandler);
    }
}

async function checkHotProducts() {
  const state = scraperInit();
  const browser = await getBrowser();
  const page = await browser.newPage();

  let interceptedData = null;

  setupPageInterception(page, async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (contentType.includes("application/json") && url.includes("productDetails")) {
      try {
        const json = await response.json();
        if (json?.code === "OK" && json?.data?.skus) {
            interceptedData = json.data;
        }
      } catch (e) {
        console.error(`Failed to parse JSON from ${url}: ${e.message}`);
      }
    }
  });

  const priorityProducts = await Product.find({ is_priority: true });
  let failedCount = 0;

  for (const product of priorityProducts) {
      interceptedData = null;
      const url = product.url;
      console.log("Visiting:", url);

      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_WAIT_TIMEOUT });

        const data = interceptedData;
        if (!data) {
          console.warn(`⚠️ Couldn't extract data for: ${product.name}`);
          failedCount++;
          continue;
        }

        const wasInStock = product.in_stock;
        const isInStock = data.skus[0].stock.onlineStock > 0;
        const imgUrl = data.skus[0].mainImage;

        if (wasInStock !== isInStock) {
          const changeType = isInStock ? ChangeTypeAlert.RESTOCK : ChangeTypeAlert.SOLD_OUT;
          product.in_stock = isInStock;
          state.alertProducts.push([product, changeType, imgUrl]);
          state.changedProductsMap[product.product_id] = product;
          console.log(`${changeType === ChangeTypeAlert.RESTOCK ? "Restock" : "Sold out"} detected: ${product.name}`);
        }

        if (failedCount / priorityProducts.length > FAIL_THRESHOLD) {
          throw new HighTrafficError("🚨 High traffic or site failure detected");
        }

      } catch (e) {
        if (e instanceof HighTrafficError) throw e;
        console.error(`❌ Error visiting ${url}: ${e.message}`);
        failedCount++;
        if (failedCount / priorityProducts.length > FAIL_THRESHOLD) {
          throw new HighTrafficError("🚨 High traffic or site failure detected");
        }
      }
  }

  await browser.close();
  await updateDb(state);
  return state.alertProducts;
}

async function checkProducts() {
  const state = scraperInit();
  const browser = await getBrowser();
  const page = await browser.newPage();

  if (!state.cache) {
    const allProducts = await Product.find();
    state.allProductsMap = allProducts.reduce((acc, product) => {
      acc[product.product_id] = product;
      return acc;
    }, {});
  }

  let currentPage = 1;
  let totalPages = 1;

  setupPageInterception(page, async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";

    if (url.includes('/shop/v1/search') && contentType.includes('application/json')) {
      try {
        const json = await response.json();

        if (json?.code === 'OK' && json?.data?.total && Array.isArray(json.data.list)) {
          totalPages = Math.ceil(json.data.total / json.data.pageSize);

          for (const item of json.data.list) {
            const {
                id: productId,
                title: name,
                skus,
                bannerImages,
                type
            } = item;

            const rawPrice = skus[0].price;
            const inStock = skus[0].stock.onlineStock > 0;
            const imgUrl = bannerImages[0];
            const product = state.allProductsMap[productId];
            const isPopNow = type === "secret";
            const slug = slugifyTitle(name);
            const productUrl = isPopNow ? `${BASE_URL}${currentPage}` : `https://www.popmart.com/us/products/${productId}/${slug}`;

            const updateField = (field, newValue) => {
                if (product[field] !== newValue) {
                    product[field] = newValue;
                    state.changedProductsMap[product.product_id] = product;
                    if (["price"].includes(field)) {
                        state.alertProducts.push([product, ChangeTypeAlert.PRICE_CHANGE, imgUrl]);
                    }
                }
            };

            try {
              if (!product) {
                // skip special items (gifts with purchase, etc)
                if(!productId || !name || !rawPrice || !inStock || !productUrl)
                  continue;

                const newProduct = new Product({
                  product_id: productId,
                  name,
                  price: rawPrice,
                  in_stock: inStock,
                  url: productUrl,
                });
                
                state.changedProductsMap[productId] = newProduct;
                state.alertProducts.push([newProduct, ChangeTypeAlert.NEW_ITEM, imgUrl]);
                console.log("Added new product:", name);
              } else {
                if (inStock && !product.in_stock) {
                  state.alertProducts.push([product, ChangeTypeAlert.RESTOCK, imgUrl]);
                  updateField("in_stock", inStock);
                  console.log("Restock detected:", name);
                }
                updateField("price", rawPrice);
                updateField("url", productUrl);
              }
            } catch (err) {
              console.error(`❌ Error processing ${name}: ${err.message}`);
            }
          }
        }
      } catch (e) {
          console.error(`Failed to parse JSON from ${url}: ${e.message}`);
      }
    }
  }, ['google-analytics.com', 'quickcep.com', 'intercom.io', 'track/v1/track/track-events']);

  console.log("Scraping product listings:");

  while (currentPage <= totalPages) {
    const searchUrl = `${BASE_URL}${currentPage}`;
    console.log(`→ Scraping page ${currentPage}...`);

    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: PAGE_WAIT_TIMEOUT });
      state.pageFails = 0;
    } catch (e) {
      state.pageFails++;
      console.error(`❌ Error on page ${currentPage}: ${e.message}`);

      if (currentPage === 1) {
        state.firstPageRetries++;
        if (state.firstPageRetries >= MAX_PAGE_FAILS) {
          throw new PageError(`Failed to connect to page 1 after ${state.firstPageRetries} attempts.`);
        }
        console.log(`🔁 Retrying page 1 in ${PAGE_RETRY_DELAY}ms...`);
        await new Promise(r => setTimeout(r, PAGE_RETRY_DELAY));
        continue;
      }

      if (state.pageFails >= MAX_PAGE_FAILS) {
        console.log(`⚠️ Skipping page ${currentPage} after ${MAX_PAGE_FAILS} failures.`);
        state.pageFails = 0;
        currentPage++;
      } else {
        console.log(`🔁 Retrying page ${currentPage}...`);
        continue;
      }
    }

    currentPage++;
  }

  await page.close();
  await browser.close();
  sharedBrowser = null; // dont leave it in case it times out
  await updateDb(state);
  return state.alertProducts;
}

module.exports = { ChangeTypeAlert, checkProducts, checkHotProducts };
