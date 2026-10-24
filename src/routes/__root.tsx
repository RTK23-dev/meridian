import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { ThemeProvider, themeBootstrap } from "@/components/ui";
import { AppQueryProvider } from "@/lib/query/client";
import { RootNotFound } from "@/components/status-pages";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  notFoundComponent: RootNotFound,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "Meridian" },
      { name: "theme-color", content: "#08070B" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <a className="skip-link" href="#main">Skip to main content</a>
        <ThemeProvider>
          <AppQueryProvider>
            <AuthProvider>
              <Outlet />
            </AuthProvider>
          </AppQueryProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  ),
});
