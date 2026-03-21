'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Beaker, BarChart3, ClipboardList, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { useState } from 'react'
import { cn } from '@/lib/utils'

interface NavItem {
  label: string
  href: string
  icon: any
  roles: string[]
}

const navItems: NavItem[] = [
  // CLIENT navigation
  { label: 'Dashboard', href: '/dashboard/client', icon: Home, roles: ['CLIENT'] },

  // LAB_ADMIN navigation
  { label: 'Dashboard', href: '/dashboard/lab', icon: Home, roles: ['LAB_ADMIN'] },
  { label: 'Orders', href: '/dashboard/lab', icon: ClipboardList, roles: ['LAB_ADMIN'] },
  { label: 'Services', href: '/dashboard/lab/services', icon: Beaker, roles: ['LAB_ADMIN'] },
  { label: 'Analytics', href: '/dashboard/lab/analytics', icon: BarChart3, roles: ['LAB_ADMIN'] },

  // ADMIN navigation
  { label: 'Dashboard', href: '/dashboard/admin', icon: Home, roles: ['ADMIN'] },
]

export function DashboardNav({ role }: { role: string }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Filter navigation items based on user role
  const roleItems = navItems.filter(item => item.roles.includes(role))

  // Check if a nav item is active
  const isActive = (href: string) => {
    if (href === '/dashboard/lab' && role === 'LAB_ADMIN') {
      // Special case: Dashboard is active only if exactly on /dashboard/lab
      return pathname === '/dashboard/lab'
    }
    return pathname === href
  }

  // Render a single navigation item (desktop)
  const renderDesktopNavItem = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.href)

    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          active
            ? "bg-secondary text-secondary-foreground shadow-sm"
            : "hover:bg-accent hover:text-accent-foreground"
        )}
        aria-current={active ? "page" : undefined}
      >
        <Icon className="h-4 w-4" />
        <span className="hidden sm:inline">{item.label}</span>
      </Link>
    )
  }

  // Render a single navigation item (mobile)
  const renderMobileNavItem = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.href)

    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors w-full",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          active
            ? "bg-secondary text-secondary-foreground"
            : "hover:bg-accent hover:text-accent-foreground"
        )}
        aria-current={active ? "page" : undefined}
        onClick={() => setMobileOpen(false)}
      >
        <Icon className="h-5 w-5" />
        <span>{item.label}</span>
      </Link>
    )
  }

  return (
    <nav className="border-b bg-white sticky top-0 z-40" aria-label="Dashboard navigation">
      <div className="container mx-auto flex items-center justify-between p-4">
        {/* Desktop Navigation */}
        <div className="hidden md:flex gap-2">
          {roleItems.map(item => renderDesktopNavItem(item))}
        </div>

        {/* Mobile Navigation */}
        <div className="flex md:hidden w-full justify-between items-center">
          <span className="font-semibold text-lg">
            {roleItems.find(item => isActive(item.href))?.label || 'Dashboard'}
          </span>

          <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation menu">
                <Menu className="h-5 w-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[300px]">
              <div className="flex flex-col gap-2 mt-4">
                <h2 className="text-lg font-semibold mb-2">Navigation</h2>
                {roleItems.map(item => renderMobileNavItem(item))}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Placeholder for future actions (logout, profile, etc.) */}
        <div className="hidden md:block"></div>
      </div>
    </nav>
  )
}
