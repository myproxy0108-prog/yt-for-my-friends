// =================================================================
// ⚙️ 設定：あなたの Cloudflare Worker の URL を貼り付けてください
// =================================================================
const API_BASE = "https://yt-api-nemu.myproxy0108.workers.dev/"; // ← ここを書き換え

// 万が一 Worker 側が一時的に 0 件を返したときの自動補完フォールバック群
const PUBLIC_INVIDIOUS_FALLBACKS = [
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://invidious.nerdvpn.de"
];

const app = {
  currentCategory: "すべて",

  init() {
    this.bindEvents();
    this.handleRoute();
    window.addEventListener("popstate", () => this.handleRoute());
  },

  bindEvents() {
    // 検索バー
    document.getElementById("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = document.getElementById("search-input").value.trim();
      if (q) {
        this.navigate(`/?q=${encodeURIComponent(q)}`);
      }
    });

    // ロゴクリックでホーム
    document.getElementById("logo-link").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("search-input").value = "";
      this.navigate("/");
    });
  },

  // 汎用 API 取得関数（Worker を優先し、必要に応じて自動フェイルオーバー）
  async fetchApi(endpointPath) {
    try {
      const res = await fetch(`${API_BASE}${endpointPath}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (err) {
      console.warn(`[Worker API Fail] Trying public Invidious fallback for: ${endpointPath}`);
      for (const base of PUBLIC_INVIDIOUS_FALLBACKS) {
        try {
          const res = await fetch(`${base}${endpointPath}`);
          if (res.ok) return await res.json();
        } catch (e) {}
      }
      throw err;
    }
  },

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

  search(category) {
    this.currentCategory = category;
    document.querySelectorAll(".chip").forEach(c => {
      c.classList.toggle("active", c.textContent === category);
    });
    const q = category === "すべて" ? "おすすめ" : category;
    this.navigate(`/?q=${encodeURIComponent(q)}`);
  },

  // 1. ホーム画面ロード
  async loadHomeView() {
    this.switchView("view-feed");
    this.showLoader(true);
    const grid = document.getElementById("video-grid");
    grid.innerHTML = "";

    try {
      const data = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent("おすすめ")}&limit=36`);
      this.renderVideoGrid(Array.isArray(data) ? data : (data.results || []), grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:#ff4e4e;padding:20px;">動画の読み込みに失敗しました: ${err.message}</p>`;
    } finally {
      this.showLoader(false);
    }
  },

  // 2. 検索画面ロード
  async loadSearchView(query) {
    this.switchView("view-feed");
    this.showLoader(true);
    const grid = document.getElementById("video-grid");
    grid.innerHTML = "";

    try {
      const data = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent(query)}&limit=36`);
      this.renderVideoGrid(Array.isArray(data) ? data : (data.results || []), grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:#ff4e4e;padding:20px;">検索エラー: ${err.message}</p>`;
    } finally {
      this.showLoader(false);
    }
  },

  // 動画カードグリッド描画
  renderVideoGrid(videos, container) {
    if (!videos || videos.length === 0) {
      container.innerHTML = "<p style='padding:20px;'>該当する動画が見つかりませんでした。</p>";
      return;
    }

    container.innerHTML = videos.map(v => {
      const thumb = v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/hqdefault.jpg`;
      const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
      const author = v.author || v.channel?.name || "YouTube Creator";
      const authorTarget = v.authorId || v.channel?.id || author;

      return `
        <div class="video-card" onclick="app.navigate('/?v=${v.videoId || v.id}')">
          <div class="thumb-wrap">
            <img src="${thumb}" loading="lazy" alt="">
            ${duration ? `<span class="duration-label">${duration}</span>` : ""}
          </div>
          <div class="card-details">
            <div class="meta-right">
              <div class="v-title" title="${this.escape(v.title)}">${this.escape(v.title)}</div>
              <div class="v-channel" onclick="event.stopPropagation(); app.smartChannelNav('${this.escape(authorTarget)}')">${this.escape(author)}</div>
              <div class="v-sub-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')} ${v.publishedText || ''}</div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  },

  // チャンネル自動判別スマートナビゲーション
  smartChannelNav(target) {
    if (target.startsWith("UC") || target.startsWith("@")) {
      this.navigate(`/?channel=${encodeURIComponent(target)}`);
    } else {
      this.navigate(`/?q=${encodeURIComponent(target)}`);
    }
  },

  // 3. 動画再生画面 (Watch) ロード
  async loadWatchView(videoId) {
    this.switchView("view-watch");

    // youtube-nocookie プレイヤーにセット
    const player = document.getElementById("nocookie-player");
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;

    // 初期化表示
    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "<p>コメントを読み込んでいます...</p>";
    document.getElementById("related-videos-list").innerHTML = "<p>関連動画を読み込んでいます...</p>";

    try {
      // 1. 動画詳細 & 関連動画の取得
      const data = await this.fetchApi(`/api/v1/videos/${videoId}`);

      document.getElementById("watch-title").textContent = data.title || "";
      document.getElementById("watch-channel-name").textContent = data.author || "";
      document.getElementById("watch-channel-name").onclick = () => this.smartChannelNav(data.authorId || data.author);
      
      const avatarUrl = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      document.getElementById("watch-channel-avatar").src = avatarUrl;
      document.getElementById("watch-channel-avatar").onclick = () => this.smartChannelNav(data.authorId || data.author);
      
      document.getElementById("watch-channel-subs").textContent = data.subCountText || "";
      document.getElementById("watch-views").textContent = (data.viewCount || 0).toLocaleString() + " 回視聴";
      document.getElementById("watch-date").textContent = data.publishedText || "";
      document.getElementById("watch-description").textContent = data.description || "説明はありません。";

      // 関連動画リストの描画（確実に取得・描画）
      let relVideos = data.recommendedVideos || [];
      if (relVideos.length === 0) {
        // 万が一空の場合は動画タイトルで検索した関連動画を補完
        const fallbackSearch = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent(data.author || "おすすめ")}&limit=18`);
        relVideos = Array.isArray(fallbackSearch) ? fallbackSearch : (fallbackSearch.results || []);
      }
      this.renderRelatedVideos(relVideos);

      // 2. コメント一覧の取得
      this.loadComments(videoId);

    } catch (err) {
      document.getElementById("watch-title").textContent = "動画の読み込みに失敗しました。";
    }
  },

  // 関連動画一覧の描画
  renderRelatedVideos(videos) {
    const list = document.getElementById("related-videos-list");
    if (!videos || videos.length === 0) {
      list.innerHTML = "<p>関連動画はありません。</p>";
      return;
    }

    list.innerHTML = videos.map(v => `
      <div class="related-item" onclick="app.navigate('/?v=${v.videoId || v.id}')">
        <div class="related-thumb-box">
          <img src="${v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/mqdefault.jpg`}" loading="lazy" alt="">
        </div>
        <div style="flex:1;min-width:0;">
          <div class="related-title">${this.escape(v.title)}</div>
          <div class="related-channel">${this.escape(v.author || v.channel?.name || '')}</div>
          <div class="related-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')}</div>
        </div>
      </div>
    `).join("");
  },

  // コメント読み込み
  async loadComments(videoId) {
    const list = document.getElementById("comments-list");
    try {
      const data = await this.fetchApi(`/api/v1/comments/${videoId}`);
      const count = data.commentCount || data.comments?.length || 0;
      document.getElementById("comments-count-title").textContent = `コメント ${count ? count.toLocaleString() + ' 件' : ''}`;

      const comments = data.comments || [];
      if (comments.length === 0) {
        list.innerHTML = "<p style='color:#aaa;'>コメントはありません。</p>";
        return;
      }

      list.innerHTML = comments.map(c => `
        <div class="comment-card">
          <img class="c-avatar" src="${c.authorThumbnails?.[0]?.url || 'https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png'}" loading="lazy" alt="">
          <div style="flex:1;">
            <div>
              <span class="c-author">${this.escape(c.author)}</span>
              <span class="c-time">${c.publishedText || ''}</span>
            </div>
            <div class="c-body">${this.escape(c.content)}</div>
            <div class="c-likes">👍 ${c.likeCount ? c.likeCount.toLocaleString() : 0}</div>
          </div>
        </div>
      `).join("");
    } catch (err) {
      list.innerHTML = "<p style='color:#aaa;'>コメントの読み込みに失敗しました。</p>";
    }
  },

  // 4. チャンネル画面ロード
  async loadChannelView(channelTarget) {
    this.switchView("view-channel");
    this.showLoader(true);
    const grid = document.getElementById("channel-video-grid");
    grid.innerHTML = "";

    try {
      const data = await this.fetchApi(`/api/v1/channels/${encodeURIComponent(channelTarget)}`);

      document.getElementById("channel-page-name").textContent = data.author || "";
      document.getElementById("channel-page-subs").textContent = data.subCount ? data.subCount.toLocaleString() + " 人の登録者" : "";
      document.getElementById("channel-page-desc").textContent = data.description || "";
      document.getElementById("channel-page-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";

      const banner = data.authorBanners?.[0]?.url;
      document.getElementById("channel-banner").style.backgroundImage = banner ? `url('${banner}')` : "none";

      this.renderVideoGrid(data.latestVideos || [], grid);
    } catch (err) {
      grid.innerHTML = `<p style="color:#ff4e4e;padding:20px;">チャンネルの取得に失敗しました: ${err.message}</p>`;
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
