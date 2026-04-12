import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  // Fetch Ruthie font from Google Fonts
  const css = await fetch(
    "https://fonts.googleapis.com/css2?family=Ruthie&display=swap",
    { headers: { "User-Agent": "Mozilla/5.0" } }
  ).then((r) => r.text());

  const fontUrl = css.match(/src: url\(([^)]+\.woff2)\)/)?.[1];
  const ruthieFont = fontUrl
    ? await fetch(fontUrl).then((r) => r.arrayBuffer())
    : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FCF8F8",
        }}
      >
        <span
          style={{
            fontSize: 26,
            color: "#F5AFAF",
            fontFamily: ruthieFont ? "Ruthie" : "serif",
            lineHeight: 1,
          }}
        >
          T
        </span>
      </div>
    ),
    {
      ...size,
      fonts: ruthieFont
        ? [{ name: "Ruthie", data: ruthieFont, style: "normal" }]
        : [],
    }
  );
}
