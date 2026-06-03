/**
 * Admin order list RSC.
 * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
 * invocable; the layout guard does not protect them. (ref: DL-005)
 * Cursor pagination with PAGE_SIZE=25; forward/backward branches with reversed orderBy
 * for backward traversal. quotedPrice serialized via ?.toFixed(2) ?? null;
 * createdAt via .toISOString(). (ref: DL-002, DL-003, DL-007)
 */
import { redirect } from 'next/navigation'
import { type OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminOrderListUi } from './ui'

const PAGE_SIZE = 25

export type AdminOrderRowDTO = {
  id: string
  status: OrderStatus
  labName: string
  clientDisplayName: string | null
  quotedPrice: string | null
  createdAt: string
}

export type AdminOrderListProps = {
  rows: AdminOrderRowDTO[]
  nextCursor: string | null
  prevCursor: string | null
  showNext: boolean
  showPrev: boolean
}

export default async function AdminOrderListPage({
  searchParams,
}: {
  searchParams: { cursor?: string | string[]; dir?: string | string[] }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  // searchParams values are `string | string[]` at runtime — narrow to a single
  // string before building the Prisma cursor; a repeated/array param drops to
  // undefined (forward, no cursor) rather than corrupting the query. Any dir
  // other than 'prev' is the documented forward default. (ref: DL-003)
  const cursor = typeof searchParams.cursor === 'string' ? searchParams.cursor : undefined
  const dir = typeof searchParams.dir === 'string' ? searchParams.dir : undefined

  // Backward traversal requires reversing orderBy so Prisma's cursor walks
  // in the opposite direction from the cursor, then the result is reversed
  // back to display (newest-first) order. (ref: DL-003)
  let rows

  if (dir === 'prev' && cursor) {
    rows = await prisma.order.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE + 1,
      cursor: { id: cursor },
      skip: 1,
      select: {
        id: true,
        status: true,
        quotedPrice: true,
        createdAt: true,
        lab: { select: { name: true } },
        clientProfile: { select: { name: true } },
      },
    })
  } else {
    rows = await prisma.order.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        quotedPrice: true,
        createdAt: true,
        lab: { select: { name: true } },
        clientProfile: { select: { name: true } },
      },
    })
  }

  let displayedRows: typeof rows
  let hasExtra: boolean

  if (dir === 'prev' && cursor) {
    hasExtra = rows.length === PAGE_SIZE + 1
    displayedRows = hasExtra ? rows.slice(0, PAGE_SIZE) : rows
    // Restore display (newest-first) order after the asc fetch. (ref: DL-003)
    displayedRows = [...displayedRows].reverse()
  } else {
    hasExtra = rows.length === PAGE_SIZE + 1
    displayedRows = hasExtra ? rows.slice(0, PAGE_SIZE) : rows
  }

  const nextCursor = displayedRows.length > 0 ? displayedRows[displayedRows.length - 1].id : null
  const prevCursor = displayedRows.length > 0 ? displayedRows[0].id : null

  // showNext: on backward traversal a next page always exists (we came from it);
  // on forward traversal the extra +1 row signals more rows exist. showPrev: on
  // backward traversal the extra +1 row signals a further prev page; on forward
  // traversal any cursor means there is a prior page. (ref: DL-003)
  const showNext = dir === 'prev' && cursor ? true : hasExtra
  const showPrev = dir === 'prev' && cursor ? hasExtra : (cursor !== undefined && cursor !== null && cursor !== '')

  const dtos: AdminOrderRowDTO[] = displayedRows.map((row) => ({
    id: row.id,
    status: row.status,
    labName: row.lab.name,
    clientDisplayName: row.clientProfile?.name ?? null,
    quotedPrice: row.quotedPrice?.toFixed(2) ?? null,
    createdAt: row.createdAt.toISOString(),
  }))

  return (
    <AdminOrderListUi
      rows={dtos}
      nextCursor={nextCursor}
      prevCursor={prevCursor}
      showNext={showNext}
      showPrev={showPrev}
    />
  )
}
