import { Layout } from './components/Layout.tsx'
import { TownPage } from './pages/TownPage.tsx'
import { FishPage } from './pages/FishPage.tsx'
import { LobbyPage } from './pages/LobbyPage.tsx'
import { TablePage } from './pages/TablePage.tsx'
import { BoardPage } from './pages/BoardPage.tsx'
import { PaperPage } from './pages/PaperPage.tsx'
import { OwnerPage } from './pages/OwnerPage.tsx'
import { CourtPage } from './pages/CourtPage.tsx'
import { RelationsPage } from './pages/RelationsPage.tsx'
import { PhonePage } from './pages/PhonePage.tsx'
import { AlbumPage } from './pages/AlbumPage.tsx'
import { GalleryPage } from './pages/GalleryPage.tsx'
import { BlessPage } from './pages/BlessPage.tsx'
import { JoinPage } from './pages/JoinPage.tsx'
import { HelpPage } from './pages/HelpPage.tsx'
import { townHref, useRoute } from './router.ts'

export function App() {
  const route = useRoute()
  return (
    <Layout>
      {route.name === 'fish' ? (
        <FishPage id={route.id} />
      ) : route.name === 'lobby' ? (
        <LobbyPage />
      ) : route.name === 'table' ? (
        <TablePage id={route.id} />
      ) : route.name === 'board' ? (
        <BoardPage />
      ) : route.name === 'paper' ? (
        <PaperPage />
      ) : route.name === 'owner' ? (
        <OwnerPage />
      ) : route.name === 'court' ? (
        <CourtPage />
      ) : route.name === 'relations' ? (
        <RelationsPage />
      ) : route.name === 'phone' ? (
        <PhonePage />
      ) : route.name === 'album' ? (
        <AlbumPage />
      ) : route.name === 'gallery' ? (
        <GalleryPage />
      ) : route.name === 'bless' ? (
        <BlessPage />
      ) : route.name === 'join' ? (
        <JoinPage />
      ) : route.name === 'help' ? (
        <HelpPage />
      ) : route.name === 'town' ? (
        <TownPage />
      ) : (
        <div className="page">
          <div className="panel notfound">
            <h2>页面走丢了</h2>
            <p>
              没找到 <code>{route.path}</code>。
            </p>
            <p>
              <a className="btn" href={townHref}>
                ← 回小镇首页
              </a>
            </p>
          </div>
        </div>
      )}
    </Layout>
  )
}
