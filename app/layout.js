export const metadata = {
  title: "Affiliate → Meta CAPI",
  description: "Affiliate postback forwarding dashboard for Meta Conversions API",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
