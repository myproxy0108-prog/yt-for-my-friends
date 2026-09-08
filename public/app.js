// =================================================================
// ⚙️ 設定：あなたの Cloudflare Worker の URL を貼り付けてください
// =================================================================
const API_BASE = "https://yt-api-nemu.myproxy0108.workers.dev/"; // ← ここを書き換え

const app = {
  init() {
    this.bindEvents();
    this.handleRoute();

    // ブラウザの戻る・進むボタンに対応
    window.addEventListener("popstate", () => this.handleRoute());
  },

  bindEvents() {
    // 検索フォーム
    document.getElementById("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const query = document.getElementById("search-input").value.trim();
      if (query) {
        this.navigate(`/?q=${encodeURIComponent(query)}`);
      }
    });

    // ロゴクリックでホーム
    document.getElementById("logo-link").addEventListener("click", (e) => {
      e.preventDefault();
      this.navigate("/");
    });
    document.getElementById("nav-home").addEventListener("click", (e) => {
      e.preventDefault();
      this.navigate("/");
    });
  },

  // SPA ルーティング判定
  handleRoute() {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get("v");
    const query = params.get("q");
    const channelId = params.get("channel");

    if (videoId) {
      this.loadWatchView(videoId);
    } else if (channelId) {
      this.loadChannelView(channelId);
    } else if (query) {
      document.getElementById("search-input").value = query;
      this.loadSearchView(query);
    } else {
      this.loadHomeView();
    }
  },

  navigate(path) {
    window.history.pushState({}, "", path);
    this.handleRoute();
  },

  showLoader(show) {
    document.getElementById("loader").style.display = show ? "flex" : "none";
  },

  switchView(viewId) {
    document.querySelectorAll(".view").forEach(el => el.style.display = "none");
    document.getElementById(viewId).style.display = "block";
    window.scrollTo(0, 0);
  },

  // 1. ホーム画面の読み込み（人気・オススメ）
  async loadHomeView() {
    this.switchView("view-feed");
    this.showLoader(true);
    const grid = document.getElementById("video-grid");
    grid.innerHTML = "";

    try {
      // デフォルトでおすすめの検索結果を表示
      const res = await fetch(`${API_BASE}/api/v1/search?q=${encodeURIComponent("おすすめ 動画")}&limit=30`);
      const videos = await res.json();
      this.renderVideoGrid(Array.isArray(videos) ? videos : (videos.results || []), grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:red;">データの読み込みに失敗しました: ${err.message}</p>`;
    } finally {
      this.showLoader(false);
    }
  },

  // 2. 検索結果の読み込み
  async loadSearchView(query) {
    this.switchView("view-feed");
    this.showLoader(true);
    const grid = document.getElementById("video-grid");
    grid.innerHTML = "";

    try {
      const res = await fetch(`${API_BASE}/api/v1/search?q=${encodeURIComponent(query)}&limit=30`);
      const videos = await res.json();
      this.renderVideoGrid(Array.isArray(videos) ? videos : (videos.results || []), grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:red;">検索エラー: ${err.message}</p>`;
    } finally {
      this.showLoader(false);
    }
  },

  // 動画グリッドカードの共通描画
  renderVideoGrid(videos, container) {
    if (!videos || videos.length === 0) {
      container.innerHTML = "<p>動画が見つかりませんでした。</p>";
      return;
    }

    container.innerHTML = videos.map(v => {
      const thumb = v.videoThumbnails ? v.videoThumbnails[0]?.url : v.thumbnail;
      const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
      const author = v.author || v.channel?.name || "YouTube Creator";
      const authorId = v.authorId || v.channel?.id || "";

      return `
        <div class="video-card" onclick="app.navigate('/?v=${v.videoId || v.id}')">
          <div class="thumbnail-box">
            <img src="${thumb}" loading="lazy" alt="">
            ${duration ? `<span class="duration-badge">${duration}</span>` : ""}
          </div>
          <div class="video-meta">
            <div class="video-info">
              <div class="video-title" title="${this.escape(v.title)}">${this.escape(v.title)}</div>
              <div class="video-channel-name" onclick="event.stopPropagation(); app.navigate('/?channel=${authorId}')">${this.escape(author)}</div>
              <div class="video-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')} ${v.publishedText || ''}</div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  },

  // 3. 動画再生画面 (Watch) の読み込み
  async loadWatchView(videoId) {
    this.switchView("view-watch");

    // youtube-nocookie プレイヤーのセット（超重要）
    const player = document.getElementById("nocookie-player");
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;

    // 初期化
    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "コメント読み込み中...";
    document.getElementById("related-videos-list").innerHTML = "";

    try {
      // 詳細・関連動画の取得
      const res = await fetch(`${API_BASE}/api/v1/videos/${videoId}`);
      const data = await res.json();

      document.getElementById("watch-title").textContent = data.title;
      document.getElementById("watch-channel-name").textContent = data.author;
      document.getElementById("watch-channel-name").onclick = () => this.navigate(`/?channel=${data.authorId}`);
      document.getElementById("watch-channel-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      document.getElementById("watch-channel-avatar").onclick = () => this.navigate(`/?channel=${data.authorId}`);
      document.getElementById("watch-channel-subs").textContent = data.subCountText || "";
      document.getElementById("watch-views").textContent = (data.viewCount || 0).toLocaleString() + " 回視聴";
      document.getElementById("watch-date").textContent = data.publishedText || "";
      document.getElementById("watch-description").textContent = data.description || "説明はありません。";

      // 関連動画の描画
      this.renderRelatedVideos(data.recommendedVideos || []);

      // コメントの取得と描画
      this.loadComments(videoId);
    } catch (err) {
      document.getElementById("watch-title").textContent = "動画情報の取得に失敗しました。";
    }
  },

  // 関連動画の描画
  renderRelatedVideos(videos) {
    const list = document.getElementById("related-videos-list");
    list.innerHTML = videos.map(v => `
      <div class="related-card" onclick="app.navigate('/?v=${v.videoId}')">
        <div class="related-thumb">
          <img src="${v.videoThumbnails?.[0]?.url}" loading="lazy" alt="">
        </div>
        <div>
          <div class="related-title">${this.escape(v.title)}</div>
          <div class="related-channel">${this.escape(v.author)}</div>
          <div class="related-views">${v.viewCountText || ''}</div>
        </div>
      </div>
    `).join("");
  },

  // コメント読み込み
  async loadComments(videoId) {
    const list = document.getElementById("comments-list");
    try {
      const res = await fetch(`${API_BASE}/api/v1/comments/${videoId}`);
      const data = await res.json();

      document.getElementById("comments-count-title").textContent = `コメント ${data.commentCount ? data.commentCount.toLocaleString() + ' 件' : ''}`;

      if (!data.comments || data.comments.length === 0) {
        list.innerHTML = "<p>コメントはありません。</p>";
        return;
      }

      list.innerHTML = data.comments.map(c => `
        <div class="comment-card">
          <img class="comment-avatar" src="${c.authorThumbnails?.[0]?.url || 'https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png'}" loading="lazy" alt="">
          <div>
            <div>
              <span class="comment-author">${this.escape(c.author)}</span>
              <span class="comment-date">${c.publishedText}</span>
            </div>
            <div class="comment-content">${this.escape(c.content)}</div>
            <div class="comment-likes">👍 ${c.likeCount || 0}</div>
          </div>
        </div>
      `).join("");
    } catch (err) {
      list.innerHTML = "<p>コメントの読み込みに失敗しました。</p>";
    }
  },

  // 4. チャンネル画面の読み込み
  async loadChannelView(channelId) {
    this.switchView("view-channel");
    this.showLoader(true);
    const grid = document.getElementById("channel-video-grid");
    grid.innerHTML = "";

    try {
      const res = await fetch(`${API_BASE}/api/v1/channels/${channelId}`);
      const data = await res.json();

      document.getElementById("channel-page-name").textContent = data.author;
      document.getElementById("channel-page-subs").textContent = (data.subCount ? data.subCount.toLocaleString() + " 人の登録者" : "");
      document.getElementById("channel-page-desc").textContent = data.description || "";
      document.getElementById("channel-page-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";

      const banner = data.authorBanners?.[0]?.url;
      document.getElementById("channel-banner").style.backgroundImage = banner ? `url('${banner}')` : "none";

      this.renderVideoGrid(data.latestVideos || [], grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:red;">チャンネル情報の取得に失敗しました: ${err.message}</p>`;
    } finally {
      this.showLoader(false);
    }
  },

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  },

  escape(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
};

document.addEventListener("DOMContentLoaded", () => app.init());
