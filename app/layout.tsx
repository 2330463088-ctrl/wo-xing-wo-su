import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "我行我诉",
  description: "以清晰步骤陪伴您完成民事诉讼准备与流程。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
