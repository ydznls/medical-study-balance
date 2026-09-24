import type { Metadata,Viewport } from "next";
import "./globals.css";
export const metadata:Metadata={title:"余量 · 医学学习与生活",description:"按周平衡，每天只推进最关键的行动。",manifest:"/manifest.webmanifest",appleWebApp:{capable:true,statusBarStyle:"default",title:"余量"},icons:{icon:[{url:"/favicon.svg",type:"image/svg+xml"}],shortcut:"/favicon.svg",apple:"/apple-touch-icon.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#f8faff"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>}
