import { useRef, useEffect } from 'react'
import { Home, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BreadcrumbProps {
  path: string
  isLocal?: boolean
  onNavigate: (path: string) => void
}

export function Breadcrumb({ path, isLocal, onNavigate }: BreadcrumbProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to end when path changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [path])

  const parts = path.split('/').filter(Boolean)
  const isRoot = path === '/'

  return (
    <div
      ref={scrollRef}
      className="flex items-center gap-0.5 overflow-x-auto scrollbar-none text-xs"
    >
      <button
        onClick={() => onNavigate('/')}
        className={cn(
          'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
          'hover:bg-accent/30 text-muted-foreground hover:text-foreground',
          isRoot && 'text-foreground font-medium'
        )}
      >
        <Home className="h-3 w-3" />
        {isLocal ? '/' : '~'}
      </button>

      {parts.map((part, idx) => {
        const partPath = '/' + parts.slice(0, idx + 1).join('/')
        const isLast = idx === parts.length - 1

        return (
          <div key={partPath} className="flex shrink-0 items-center">
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <button
              onClick={() => onNavigate(partPath)}
              className={cn(
                'rounded px-1.5 py-0.5 transition-colors truncate max-w-[150px]',
                'hover:bg-accent/30',
                isLast
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {part}
            </button>
          </div>
        )
      })}
    </div>
  )
}
