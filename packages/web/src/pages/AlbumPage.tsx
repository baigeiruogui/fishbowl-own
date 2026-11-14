import { useMemo, useState } from 'react'
import { loadAlbum } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { isSafeImageSrc, relTime } from '../format.ts'
import type { AlbumKind, AlbumPayload } from '../types.ts'

const KIND_LABEL: Record<string, string> = { photo: '照片', painting: '画', song: '歌' }
const KIND_ICON: Record<string, string> = { photo: '📷', painting: '🎨', song: '🎵' }
const FILTERS = ['all', 'photo', 'painting', 'song'] as const

export function AlbumPage() {
  const { loading, result } = useResource<AlbumPayload>(() => loadAlbum(), [])
  const [kind, setKind] = useState<(typeof FILTERS)[number]>('all')

  const items = result?.data.items ?? []
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, photo: 0, painting: 0, song: 0 }
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1
    return c
  }, [items])
  const filtered = kind === 'all' ? items : items.filter((it) => it.kind === kind)

  if (loading || !result) return <Loading label="正在翻开相册…" />

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">ALBUM</p>
            <h1 className="hero__title">
              相册<span aria-hidden="true">📷</span>
            </h1>
            <p className="hero__sub">小镇里拍下的照片、画的画、点过的歌。歌只有标题卡，暂时还没有音频。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>全部作品</h2>
          <div className="segmented" role="tablist" aria-label="按类型筛选">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={kind === f}
                className={`segmented__btn ${kind === f ? 'is-active' : ''}`}
                onClick={() => setKind(f)}
              >
                {f === 'all' ? '全部' : `${KIND_ICON[f]} ${KIND_LABEL[f]}`} {counts[f] ?? 0}
              </button>
            ))}
          </div>
        </header>

        {filtered.length === 0 ? (
          <Empty>这个分类下还没有作品。</Empty>
        ) : (
          <div className="album-grid">
            {filtered.map((it) => (
              <article key={it.id} className={`album-item album-item--${it.kind}`}>
                <div className="album-thumb">
                  {isSafeImageSrc(it.path) ? (
                    <img className="album-thumb__img" src={it.path} alt={it.title} loading="lazy" />
                  ) : (
                    <div className="album-thumb__placeholder" aria-hidden="true">
                      🎵
                    </div>
                  )}
                  <span className="album-kind-tag">
                    {KIND_ICON[it.kind] ?? '📦'} {KIND_LABEL[it.kind] ?? it.kind}
                  </span>
                </div>
                <div className="album-meta">
                  <div className="album-title">{it.title}</div>
                  <div className="album-sub">
                    {it.fishName ?? '—'} · {relTime(it.ts)}
                  </div>
                  {it.kind === 'song' ? <div className="album-note">🎧 暂无音频，仅标题卡</div> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export type { AlbumKind }
