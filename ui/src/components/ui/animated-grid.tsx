import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

const CELL_SIZE = 38 // ~1cm at 96dpi
const DOT_COUNT = 5
const DOT_RADIUS = 1.5
const DOT_SPEED = 0.4 // px per frame
const DOT_OPACITY = 0.18
const GRID_OPACITY = 0.06
const DARK_GRID_OPACITY = 0.08
const DARK_DOT_OPACITY = 0.12
// Target animation frame rate — 5 dots moving 0.4 px/frame look identical at 30 fps,
// for half the GPU cost. The main canvas is only redrawn at this cadence.
const TARGET_FPS = 30
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS

interface Dot {
  x: number
  y: number
  dx: number
  dy: number
  distToNext: number // distance remaining to next intersection
}

function pickDirection(): [number, number] {
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]
  return dirs[Math.floor(Math.random() * dirs.length)]
}

function initDot(w: number, h: number): Dot {
  // Start at a random grid intersection
  const cols = Math.floor(w / CELL_SIZE)
  const rows = Math.floor(h / CELL_SIZE)
  const col = Math.floor(Math.random() * cols)
  const row = Math.floor(Math.random() * rows)
  const [dx, dy] = pickDirection()
  return {
    x: col * CELL_SIZE,
    y: row * CELL_SIZE,
    dx,
    dy,
    distToNext: CELL_SIZE
  }
}

// Background colors matching globals.css theme tokens (avoids DOM sampling timing issues)
const LIGHT_BG: [number, number, number] = [252, 252, 252] // oklch(0.99 0 0)
const DARK_BG: [number, number, number] = [9, 9, 9] // oklch(0.13 0 0)

interface AnimatedGridProps {
  className?: string
  /** Show radial vignette that fades grid towards center (default: true) */
  vignette?: boolean
}

/**
 * Subtle animated grid background. Renders two layered canvases:
 *   1. A static offscreen canvas with the grid lines + radial vignette — drawn
 *      ONCE per resize / theme toggle (expensive: full-screen stroke + gradient fill).
 *   2. The visible canvas, which each frame only clears, blits the cached grid
 *      via drawImage(), then draws 5 dots on top.
 *
 * On a 1920×1080 Retina display this cuts the per-frame work from ~500 M pixel
 * operations to a single drawImage() + 5 tiny arc fills. Combined with a 30 fps
 * cap (visually identical at 0.4 px/frame motion), GPU cost drops >10×.
 */
export function AnimatedGrid({ className, vignette = true }: AnimatedGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dotsRef = useRef<Dot[]>([])
  const rafRef = useRef<number>(0)
  const isDarkRef = useRef(false)
  const vignetteRef = useRef(vignette)
  vignetteRef.current = vignette

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Offscreen canvas caches the static grid+vignette at device pixel resolution.
    const bg = document.createElement('canvas')
    const bgCtx = bg.getContext('2d')
    if (!bgCtx) return

    isDarkRef.current = document.documentElement.classList.contains('dark')

    /** Draw the static layer (grid + vignette) into the offscreen canvas. */
    const paintBackground = (w: number, h: number, dpr: number, dark: boolean) => {
      bg.width = w * dpr
      bg.height = h * dpr
      bg.style.width = w + 'px'
      bg.style.height = h + 'px'
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      bgCtx.clearRect(0, 0, w, h)

      // Grid
      bgCtx.strokeStyle = dark
        ? `rgba(255, 255, 255, ${DARK_GRID_OPACITY})`
        : `rgba(0, 0, 0, ${GRID_OPACITY})`
      bgCtx.lineWidth = 0.5
      bgCtx.beginPath()
      for (let x = 0; x <= w; x += CELL_SIZE) {
        bgCtx.moveTo(x + 0.5, 0)
        bgCtx.lineTo(x + 0.5, h)
      }
      for (let y = 0; y <= h; y += CELL_SIZE) {
        bgCtx.moveTo(0, y + 0.5)
        bgCtx.lineTo(w, y + 0.5)
      }
      bgCtx.stroke()

      // Vignette
      if (vignetteRef.current) {
        const b = dark ? DARK_BG : LIGHT_BG
        const grad = bgCtx.createRadialGradient(
          w / 2,
          h / 2,
          0,
          w / 2,
          h / 2,
          Math.max(w, h) * 0.65
        )
        grad.addColorStop(0, `rgba(${b[0]}, ${b[1]}, ${b[2]}, 1)`)
        grad.addColorStop(0.25, `rgba(${b[0]}, ${b[1]}, ${b[2]}, 0.85)`)
        grad.addColorStop(0.5, `rgba(${b[0]}, ${b[1]}, ${b[2]}, 0.4)`)
        grad.addColorStop(1, `rgba(${b[0]}, ${b[1]}, ${b[2]}, 0)`)
        bgCtx.fillStyle = grad
        bgCtx.fillRect(0, 0, w, h)
      }
    }

    let currentW = 0
    let currentH = 0
    let currentDpr = 1

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const dpr = window.devicePixelRatio || 1
      const w = parent.clientWidth
      const h = parent.clientHeight
      if (w === 0 || h === 0) return
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      currentW = w
      currentH = h
      currentDpr = dpr

      // Re-init dots
      dotsRef.current = Array.from({ length: DOT_COUNT }, () => initDot(w, h))
      // Re-paint the background layer
      paintBackground(w, h, dpr, isDarkRef.current)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)

    // Repaint the cached layer when theme toggles (colors change).
    const observer = new MutationObserver(() => {
      const next = document.documentElement.classList.contains('dark')
      if (next !== isDarkRef.current) {
        isDarkRef.current = next
        paintBackground(currentW, currentH, currentDpr, next)
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    let lastFrame = 0
    const animate = (now: number) => {
      rafRef.current = requestAnimationFrame(animate)
      // Throttle: only update at TARGET_FPS
      if (now - lastFrame < FRAME_INTERVAL_MS) return
      lastFrame = now

      const w = currentW
      const h = currentH
      const dark = isDarkRef.current

      // Clear + blit cached background (one GPU-accelerated drawImage)
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(bg, 0, 0, w, h)

      // Move + draw the 5 dots
      ctx.fillStyle = dark
        ? `rgba(160, 140, 255, ${DARK_DOT_OPACITY})`
        : `rgba(120, 80, 200, ${DOT_OPACITY})`
      for (const dot of dotsRef.current) {
        dot.x += dot.dx * DOT_SPEED
        dot.y += dot.dy * DOT_SPEED
        dot.distToNext -= DOT_SPEED

        if (dot.distToNext <= 0) {
          dot.x = Math.round(dot.x / CELL_SIZE) * CELL_SIZE
          dot.y = Math.round(dot.y / CELL_SIZE) * CELL_SIZE
          const [ndx, ndy] = pickDirection()
          dot.dx = ndx
          dot.dy = ndy
          dot.distToNext = CELL_SIZE
        }

        if (dot.x < -CELL_SIZE) dot.x = w + CELL_SIZE
        if (dot.x > w + CELL_SIZE) dot.x = -CELL_SIZE
        if (dot.y < -CELL_SIZE) dot.y = h + CELL_SIZE
        if (dot.y > h + CELL_SIZE) dot.y = -CELL_SIZE

        ctx.beginPath()
        ctx.arc(dot.x, dot.y, DOT_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    rafRef.current = requestAnimationFrame(animate)

    // Pause animation when the tab is hidden (background or minimized) — wastes
    // both CPU on macOS and bandwidth when streamed through the tunnel.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current)
      } else {
        lastFrame = 0
        rafRef.current = requestAnimationFrame(animate)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={cn('pointer-events-none absolute inset-0 z-0', className)}
      aria-hidden="true"
    />
  )
}
