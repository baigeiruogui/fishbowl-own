import { useState } from 'react'
import { loadGallery } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { fmtCoins } from '../format.ts'
import { isSafeImageSrc } from '../format.ts'
import type { GalleryPayload } from '../types.ts'

export function GalleryPage() {
  const { loading, result } = useResource<GalleryPayload>(loadGallery, [])
  const [notice, setNotice] = useState<string | null>(null)

  if (loading || !result) return <Loading label="正在逛画铺…" />
  const items = result.data.items

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">GALLERY</p>
            <h1 className="hero__title">
              画铺<span aria-hidden="true">🖼️</span>
            </h1>
            <p className="hero__sub">镇上被挂出来出售的画。价格是鱼币，买下按钮先做占位（实际购买走鱼自己的钱包）。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>挂出的画</h2>
          <span className="panel__hint">{items.length} 幅</span>
        </header>
        {items.length === 0 ? (
          <Empty>画铺还空着，等鱼来挂画。</Empty>
        ) : (
          <div className="gallery-grid">
            {items.map((it) => (
              <article key={it.id} className="gallery-card">
                <div className="gallery-thumb">
                  {isSafeImageSrc(it.path) ? (
                    <img className="gallery-thumb__img" src={it.path} alt={it.title} loading="lazy" />
                  ) : (
                    <div className="gallery-thumb__placeholder" aria-hidden="true">
                      🖼️
                    </div>
                  )}
                </div>
                <div className="gallery-meta">
                  <div className="gallery-title">{it.title}</div>
                  <div className="gallery-price">
                    {it.price !== undefined ? (
                      <>
                        <span className="gallery-price__num">{fmtCoins(it.price)}</span> 鱼币
                      </>
                    ) : (
                      <span className="gallery-price__num">面议</span>
                    )}
                  </div>
                </div>
                {it.scene ? <div className="gallery-scene">{it.scene}</div> : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    setNotice(
                      `「${it.title}」${it.price !== undefined ? `售价 ${fmtCoins(it.price)} 鱼币` : '价格面议'}：购买需要鱼本人钱包，网页端先做占位。`,
                    )
                  }
                >
                  买下
                </button>
              </article>
            ))}
          </div>
        )}
        {notice ? <p className="inline-note">{notice}</p> : null}
      </section>
    </div>
  )
}
