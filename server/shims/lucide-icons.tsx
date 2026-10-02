import { createElement, forwardRef, type ComponentType, type SVGProps } from 'react'
import * as realIcons from 'lucide-react'

export * from 'lucide-react'

const warned = new Set<string>()
const icons = realIcons as unknown as Record<string, ComponentType<SVGProps<SVGSVGElement>>>

function fallbackIcon(name: string) {
  return forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function FallbackIcon(props, ref) {
    if (!warned.has(name)) {
      warned.add(name)
      console.warn(`lucide-react has no "${name}" icon in this version; using a placeholder`)
    }
    return createElement(
      'svg',
      { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', ...props, ref },
      createElement('circle', { cx: 12, cy: 12, r: 9 }),
      createElement('text', { x: 12, y: 15.5, fontSize: 9, fontFamily: 'sans-serif', textAnchor: 'middle', stroke: 'none', fill: 'currentColor' }, name[0]?.toUpperCase() ?? '?'),
    )
  })
}

function iconOrFallback(name: string) {
  return icons[name] ?? fallbackIcon(name)
}

export const Github = iconOrFallback('Github')
export const Linkedin = iconOrFallback('Linkedin')
export const Twitter = iconOrFallback('Twitter')
export const Facebook = iconOrFallback('Facebook')
export const Instagram = iconOrFallback('Instagram')
export const Youtube = iconOrFallback('Youtube')
export const Discord = iconOrFallback('Discord')
export const Slack = iconOrFallback('Slack')
export const Figma = iconOrFallback('Figma')
export const Dribbble = iconOrFallback('Dribbble')
export const Behance = iconOrFallback('Behance')
export const Gitlab = iconOrFallback('Gitlab')
export const Bitbucket = iconOrFallback('Bitbucket')
export const Twitch = iconOrFallback('Twitch')
export const Reddit = iconOrFallback('Reddit')
export const Telegram = iconOrFallback('Telegram')
export const Whatsapp = iconOrFallback('Whatsapp')
export const Pinterest = iconOrFallback('Pinterest')
export const Tiktok = iconOrFallback('Tiktok')
export const Codepen = iconOrFallback('Codepen')
export const Npm = iconOrFallback('Npm')
export const Docker = iconOrFallback('Docker')
export const Spotify = iconOrFallback('Spotify')
export const Google = iconOrFallback('Google')
export const Chrome = iconOrFallback('Chrome')
export const Windows = iconOrFallback('Windows')
