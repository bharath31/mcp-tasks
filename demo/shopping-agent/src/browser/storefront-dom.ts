import type { CartLineSnapshot, GridArticleSnapshot } from "../dom.js";

/** Pure DOM scrape helpers (Stillroom storefront shape); used in tests and mirrored in page.evaluate. */
export function scrapeGridArticlesFromDocument(
  doc: Document,
  gridSel: string,
): GridArticleSnapshot[] {
  const grid = doc.querySelector(gridSel);
  if (!grid) return [];
  return Array.from(grid.querySelectorAll("article")).map((article) => {
    const name =
      article.querySelector(".product-heading h3")?.textContent?.trim() ?? "";
    const priceText =
      article.querySelector(".product-heading b")?.textContent?.trim() ?? "";
    const button = article.querySelector("button");
    return {
      name,
      priceText,
      buttonLabel: (button?.textContent ?? "").trim(),
      buttonDisabled: Boolean(
        button?.hasAttribute("disabled") ||
        (button as HTMLButtonElement | null)?.disabled,
      ),
    };
  });
}

export function scrapeCartLinesFromDocument(
  doc: Document,
  listSel: string,
): CartLineSnapshot[] {
  const root = doc.querySelector(listSel);
  if (!root) return [];
  return Array.from(root.querySelectorAll("li")).map((li) => ({
    nameLine: li.querySelector(":scope > span")?.textContent?.trim() ?? "",
    quantityText: li.querySelector("div > span")?.textContent?.trim() ?? "0",
  }));
}

export function countExactGridProductNames(
  articles: GridArticleSnapshot[],
  displayName: string,
): number {
  const target = displayName.trim();
  return articles.filter((a) => a.name.trim() === target).length;
}
