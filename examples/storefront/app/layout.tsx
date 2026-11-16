import "./style.css";
export const metadata = {
  title: "Stillroom Supply",
  description: "Useful things for the working day.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
