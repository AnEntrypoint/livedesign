import { StrictMode, type ComponentType } from "react"
import { createRoot, type Root } from "react-dom/client"

type PageModule = { default: ComponentType }

const appGlobalStylesheets = import.meta.glob("./app/globals.css", { eager: true })
const legacyGlobalStylesheetLoaders = import.meta.glob("./styles/globals.css")
const pageModules = import.meta.glob<PageModule>("./app/page.{tsx,jsx,ts,js}", { eager: true })
const [entryPagePath, entryModule] = Object.entries(pageModules)[0] ?? []

function followSystemColorScheme() {
  if (import.meta.hot?.data.followingColorScheme) return
  if (import.meta.hot) import.meta.hot.data.followingColorScheme = true
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

function pageOf(pageModule?: PageModule): ComponentType {
  return pageModule?.default ?? MissingPage
}

async function mount() {
  await loadLegacyGlobalStylesheets()
  followSystemColorScheme()
  showPageLoadCount()

  const rootElement = document.getElementById("root")
  if (!rootElement) throw new Error("index.html has no #root element to mount into")

  const root: Root = import.meta.hot?.data.root ?? createRoot(rootElement)
  if (import.meta.hot) import.meta.hot.data.root = root

  let mountedPage = pageOf(entryModule)
  const render = (Page: ComponentType) => root.render(
    <StrictMode>
      <Page />
    </StrictMode>
  )
  render(mountedPage)

  import.meta.hot?.on("vite:afterUpdate", async () => {
    if (!entryPagePath) return
    try {
      const latestModule: PageModule = await import(/* @vite-ignore */ `${entryPagePath}?t=${Date.now()}`)
      const latestPage = pageOf(latestModule)
      if (latestPage.name === mountedPage.name) return
      mountedPage = latestPage
      render(latestPage)
    } catch (error) {
      console.debug("[hmr-live] component rename check skipped", error)
    }
  })
}

import.meta.hot?.accept()

void mount()
