import type {Metadata} from 'next';
import './fonts.css';
import './globals.css';
export const metadata:Metadata={title:'TeamForge · AI Engineering Team',description:'Multi-agent coding workspace with human approvals'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="fa" dir="rtl"><body>{children}</body></html>}
