"use client"

import type React from "react"
import { useEffect, useRef } from "react"
import { Renderer, Program, Mesh, Triangle } from "ogl"
import "./Plasma.css"

interface PlasmaProps {
  color?: string
  speed?: number
  direction?: "forward" | "reverse" | "pingpong"
  scale?: number
  opacity?: number
  mouseInteractive?: boolean
}

const hexToRgb = (hex: string): [number, number, number] => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return [1, 0.5, 0.2]
  return [
    Number.parseInt(result[1], 16) / 255,
    Number.parseInt(result[2], 16) / 255,
    Number.parseInt(result[3], 16) / 255,
  ]
}

const vertex = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform vec3 uCustomColor;
uniform float uUseCustomColor;
uniform float uSpeed;
uniform float uDirection;
uniform float uScale;
uniform float uOpacity;
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    vec2 p = (gl_FragCoord.xy - iResolution.xy * 0.5) / iResolution.y;
    p *= uScale;

    float T = iTime * uSpeed * uDirection;
    
    float v = 0.0;
    v += sin(p.x + T);
    v += sin((p.y + T) * 0.5);
    v += sin((p.x + p.y + T) * 0.5);
    
    vec2 c = p + vec2(sin(T), cos(T));
    v += sin(sqrt(c.x * c.x + c.y * c.y + 1.0) + T);
    
    v = sin(v * 3.14159265 * 0.5);
    v = 0.5 + 0.5 * v;

    vec3 color1 = vec3(0.95, 0.0, 0.55);
    vec3 color2 = vec3(0.55, 0.0, 0.25);
    vec3 baseColor = mix(color2, color1, v);
    vec3 finalColor = mix(baseColor, uCustomColor, step(0.5, uUseCustomColor));

    fragColor = vec4(finalColor, uOpacity);
}
`

export const Plasma: React.FC<PlasmaProps> = ({
  color = "#ff007f",
  speed = 0.2,
  direction = "pingpong",
  scale = 2.6,
  opacity = 0.95,
  mouseInteractive = true,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    const isMobile = window.innerWidth < 768
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
    const saveData = (navigator as any)?.connection?.saveData === true
    const animate = !prefersReducedMotion && !saveData

    const useCustomColor = color ? 1.0 : 0.0
    const customColorRgb = color ? hexToRgb(color) : [1, 1, 1]
    const directionMultiplier = direction === "reverse" ? -1.0 : 1.0

    const renderer = new Renderer({
      webgl: 2,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: !animate,
      dpr: Math.max(0.5, Math.min(window.devicePixelRatio || 1, isMobile ? 1 : 2) * (isIOS || isMobile ? 0.5 : 1)),
    })
    const gl = renderer.gl
    const canvas = gl.canvas as HTMLCanvasElement
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;z-index:-1;"
    containerRef.current.appendChild(canvas)

    const geometry = new Triangle(gl)
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Float32Array([1, 1]) },
        uCustomColor: { value: new Float32Array(customColorRgb) },
        uUseCustomColor: { value: useCustomColor },
        uSpeed: { value: speed * (isMobile ? 0.3 : 0.4) },
        uDirection: { value: directionMultiplier },
        uScale: { value: isMobile ? scale * 1.2 : scale },
        uOpacity: { value: Math.min(0.8, opacity) },
      },
    })
    const mesh = new Mesh(gl, { geometry, program })

    let resizeTimer: number
    const applySize = () => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      renderer.setSize(width, height)
      const res = program.uniforms.iResolution.value as Float32Array
      res[0] = gl.drawingBufferWidth
      res[1] = gl.drawingBufferHeight
      if (!animate) renderer.render({ scene: mesh })
    }
    const setSize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(applySize, 50)
    }
    const ro = new ResizeObserver(setSize)
    ro.observe(containerRef.current)
    applySize()

    let raf = 0
    let lastTime = 0
    let running = true
    const targetDelta = isMobile ? 50 : 16
    const t0 = performance.now()

    const loop = (t: number) => {
      if (!running) return
      const delta = t - lastTime
      if (delta >= targetDelta) {
        const timeValue = (t - t0) * 0.001
        if (direction === "pingpong") {
          const cycle = Math.sin(timeValue * 0.5)
          ;(program.uniforms.uDirection as any).value = cycle
        }
        ;(program.uniforms.iTime as any).value = timeValue
        renderer.render({ scene: mesh })
        lastTime = t
      }
      raf = requestAnimationFrame(loop)
    }

    if (animate) {
      raf = requestAnimationFrame(loop)
    }

    const onVisibility = () => {
      if (!animate) return
      const hidden = document.visibilityState === "hidden"
      if (hidden && running) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!hidden && !running) {
        running = true
        lastTime = 0
        raf = requestAnimationFrame(loop)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      clearTimeout(resizeTimer)
      try {
        containerRef.current?.removeChild(canvas)
      } catch {}
    }
  }, [color, speed, direction, scale, opacity, mouseInteractive])

  return <div ref={containerRef} className="absolute inset-0 overflow-hidden -z-10" />
}

export default Plasma