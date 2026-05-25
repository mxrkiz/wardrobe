// Categories: spine slot + default z-index + suggested subcategories.
//
// Visual top→bottom order in the wardrobe tree (the `order` field):
//   hat · glasses · neck · outerwear · top·mid · top·base · bottoms · shoes · accessory
//
// The three torso layers (outerwear / mid / top) sit at the same Y on the
// spine and differ only in z-order, so a jacket (z50) covers a hoodie (z40)
// which covers a t-shirt (z30) — without manual reordering. hat is z55 so it
// always clears an outerwear collar.

export const CATEGORIES = {
  uncategorized: {
    label: "uncategorized",
    relY: 0.5,
    targetH: 0.20,
    z: 100,
    order: -1,
    subcategories: [],
  },
  hat: {
    label: "hat",
    relY: 0.07,
    targetH: 0.10,
    z: 55,
    order: 0,
    subcategories: ["cap", "beanie", "hat", "bucket", "baseball", "beret"],
  },
  glasses: {
    label: "glasses",
    relY: 0.13,
    targetH: 0.05,
    z: 60,
    order: 1,
    subcategories: ["sunglasses", "optical", "sport"],
  },
  neck: {
    label: "neck",
    relY: 0.22,
    targetH: 0.08,
    z: 45,
    order: 2,
    subcategories: ["scarf", "snood", "necktie", "collar", "bandana", "kerchief"],
  },
  outerwear: {
    label: "outerwear",
    relY: 0.38,
    targetH: 0.34,
    z: 50,
    order: 3,
    subcategories: [
      "jacket", "coat", "windbreaker", "bomber", "trench",
      "puffer", "raincoat", "leather",
    ],
  },
  mid: {
    label: "top·mid",
    relY: 0.37,
    targetH: 0.28,
    z: 40,
    order: 4,
    subcategories: ["hoodie", "sweatshirt", "sweater", "cardigan", "vest"],
  },
  top: {
    label: "top·base",
    relY: 0.37,
    targetH: 0.26,
    z: 30,
    order: 5,
    subcategories: [
      "t-shirt", "tank", "longsleeve", "polo", "turtleneck", "shirt", "blouse",
    ],
  },
  bottoms: {
    label: "bottoms",
    relY: 0.65,
    targetH: 0.30,
    z: 20,
    order: 6,
    subcategories: [
      "jeans", "trousers", "shorts", "joggers", "sweatpants", "skirt", "leggings",
    ],
  },
  shoes: {
    label: "shoes",
    relY: 0.92,
    targetH: 0.08,
    z: 25,
    order: 7,
    subcategories: [
      "sneakers", "canvas", "boots", "tall-boots", "dress", "loafers",
      "mules", "sandals",
    ],
  },
  accessory: {
    label: "accessory",
    relY: 0.50,
    targetH: 0.12,
    z: 70,
    order: 8,
    subcategories: [
      "watch", "chain", "bracelet", "bag", "backpack", "belt", "gloves", "tattoo",
    ],
  },
};

export const ALL_CATEGORIES = Object.keys(CATEGORIES).sort(
  (a, b) => CATEGORIES[a].order - CATEGORIES[b].order,
);
