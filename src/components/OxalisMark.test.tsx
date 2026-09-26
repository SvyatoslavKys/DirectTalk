import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OxalisMark, type OxalisState } from "./OxalisMark";

describe("OxalisMark", () => {
  it.each<OxalisState>(["offline", "connecting", "online"])("renders the %s state", (state) => {
    const markup = renderToStaticMarkup(<OxalisMark state={state} />);
    expect(markup).toContain(`data-state="${state}"`);
    expect(markup.match(/oxalis-mark__leaf oxalis-mark__leaf--/gu)).toHaveLength(3);
  });

  it("uses separate SVG paint ids for every mark", () => {
    const markup = renderToStaticMarkup(
      <>
        <OxalisMark state="offline" />
        <OxalisMark state="online" />
      </>,
    );
    const ids = [...markup.matchAll(/id="([^"]+-oxalis-top)"/gu)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
