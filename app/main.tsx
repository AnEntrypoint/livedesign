import { StrictMode, type ComponentType } from "react"
import { createRoot } from "react-dom/client"

const appGlobalStylesheets = import.meta.glob("./app/globals.css", { eager: true })
const legacyGlobalStylesheetLoaders = import.meta.glob("./styles/globals.css")
const pageModules = import.meta.glob<{ default: ComponentType }>("./app/page.{tsx,jsx,ts,js}", { eager: true })

function followSystemColorScheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)")
  const applyScheme = () => document.documentElement.classList.toggle("dark", prefersDark.matches)
  applyScheme()
  prefersDark.addEventListener("change", applyScheme)
}

function showPageLoadCount() {
  const badge = document.getElementById("page-loads")
  if (badge) badge.textContent = `Page loads this tab: ${document.documentElement.dataset.loads}`
}

async function loadLegacyGlobalStylesheets() {
  if (Object.keys(appGlobalStylesheets).length > 0) return
  await Promise.all(Object.values(legacyGlobalStylesheetLoaders).map((load) => load()))
}

function MissingPage() {
  return <p className="p-8 text-muted-foreground">No app/page.tsx found in this project.</p>
}

async function mount() {
  await loadLegacyGlobalStylesheets()
  followSystemColorScheme()
  showPageLoadCount()

  const rootElement = document.getElementById("root")
  if (!rootElement) throw new Error("index.html has no #root element to mount into")

  const Page = Object.values(pageModules)[0]?.default ?? MissingPage
  createRoot(rootElement).render(
    <StrictMode>
      <Page />
    </StrictMode>
  )
}

void mount()
