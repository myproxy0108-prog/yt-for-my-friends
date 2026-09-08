const API_BASE = "https://api-nemu-utube.myproxy0108.workers.dev"; // ← ここを書き換え

// 自動フォールバック（Worker が一時的に空を返した時の二重防壁）
const FALLBACK_APIS = [
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://invidious.nerdvpn.de"
];

const app = {
  currentCategory: "すべて",
  currentQuery: "おすすめ",
  currentVideoId: null,
  currentChannelTarget: null,

  // 無限スクロール用 Continuation トークン
  feedToken: null,
  commentsToken: null,
  channelToken: null,

  // 重複リクエスト防止フラグ
  isFetchingFeed: false,
  isFetchingComments: false,
  isFetchingChannel: false,

  init() {
    this.bindEvents();
    this.setupInfiniteScroll();
    this.handleRoute();
    window.addEventListener("popstate", () => this.handleRoute());
  },

  bindEvents() {
    // 検索フォーム
    document.getElementById("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = document.getElementById("search-input").value.trim();
      if (q) {
        this.navigate(`/?q=${encodeURIComponent(q)}`);
      }
    });

    // ロゴクリック
    document.getElementById("logo-link").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("search-input").value = "";
      this.navigate("/");
    });
  },

  // =================================================================
  // 【不発完全防止】ハイブリッド無限スクロール監視エンジン
  // IntersectionObserver + Window Scroll イベントの二重監視
  // =================================================================
  setupInfiniteScroll() {
    const observerOptions = {
      root: null,
      rootMargin: "800px", // 画面外800px手前で高速先読み
      threshold: 0
    };

    // 1. IntersectionObserver による自動検知
    const feedSentinel = document.getElementById("feed-sentinel");
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.feedToken && !this.isFetchingFeed) {
        this.loadMoreFeed();
      }
    }, observerOptions).observe(feedSentinel);

    const commentsSentinel = document.getElementById("comments-sentinel");
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.commentsToken && !this.isFetchingComments) {
        this.loadMoreComments();
      }
    }, observerOptions).observe(commentsSentinel);

    const channelSentinel = document.getElementById("channel-sentinel");
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.channelToken && !this.isFetchingChannel) {
        this.loadMoreChannelVideos();
      }
    }, observerOptions).observe(channelSentinel);

    // 2. Window Scroll イベントによるバックアップ検知（すり抜けを完全防止）
    let scrollTimeout = null;
    window.addEventListener("scroll", () => {
      if (scrollTimeout) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;

        // ページ最下部から 800px 手前に達した瞬間に追加読み込みを実行
        if (scrollBottom >= docHeight - 800) {
          const viewFeed = document.getElementById("view-feed");
          const viewWatch = document.getElementById("view-watch");
          const viewChannel = document.getElementById("view-channel");

          if (viewFeed.style.display !== "none" && this.feedToken && !this.isFetchingFeed) {
            this.loadMoreFeed();
          } else if (viewWatch.style.display !== "none" && this.commentsToken && !this.isFetchingComments) {
            this.loadMoreComments();
          } else if (viewChannel.style.display !== "none" && this.channelToken && !this.isFetchingChannel) {
            this.loadMoreChannelVideos();
          }
        }
      }, 150);
    }, { passive: true });
  },

  // API 通信
  async fetchApi(endpointPath) {
    try {
      const res = await fetch(`${API_BASE}${endpointPath}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[Worker API Fail] Trying fallback for: ${endpointPath}`);
      for (const base of FALLBACK_APIS) {
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

  // =================================================================
  // 1. ホーム / 検索一覧（初回 ＆ 無限追加読み込み）
  // =================================================================
  async loadHomeView() {
    this.switchView("view-feed");
    this.currentQuery = "おすすめ";
    this.feedToken = null;
    document.getElementById("video-grid").innerHTML = "";
    document.getElementById("feed-sentinel").style.display = "flex";
    await this.loadMoreFeed();
  },

  async loadSearchView(query) {
    this.switchView("view-feed");
    this.currentQuery = query;
    this.feedToken = null;
    document.getElementById("video-grid").innerHTML = "";
    document.getElementById("feed-sentinel").style.display = "flex";
    await this.loadMoreFeed();
  },

  async loadMoreFeed() {
    if (this.isFetchingFeed) return;
    this.isFetchingFeed = true;
    const grid = document.getElementById("video-grid");

    try {
      const endpoint = this.feedToken
        ? `/api/v1/search?continuation=${encodeURIComponent(this.feedToken)}`
        : `/api/v1/search?q=${encodeURIComponent(this.currentQuery)}&limit=50`;

      const data = await this.fetchApi(endpoint);
      const videos = Array.isArray(data) ? data : (data.results || []);
      this.feedToken = data.continuation || null;

      this.appendVideosToGrid(videos, grid);

      if (!this.feedToken) {
        document.getElementById("feed-sentinel").style.display = "none";
      }
    } catch (err) {
      if (!this.feedToken) grid.innerHTML = `<p style="color:#ff4e4e;padding:20px;">動画の取得に失敗しました: ${err.message}</p>`;
      document.getElementById("feed-sentinel").style.display = "none";
    } finally {
      this.isFetchingFeed = false;
    }
  },

  appendVideosToGrid(videos, container) {
    if (!videos || videos.length === 0) return;

    const html = videos.map(v => {
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

    container.insertAdjacentHTML("beforeend", html);
  },

  // =================================================================
  // 2. 動画再生画面 (Watch Page)
  // 【左側】巨大プレイヤー + コメント（無限スクロール）
  // 【右側】関連動画（縦並びで右側に固定）
  // =================================================================
  async loadWatchView(videoId) {
    this.switchView("view-watch");
    this.currentVideoId = videoId;
    this.commentsToken = null;

    // プレイヤーの読み込み
    const player = document.getElementById("nocookie-player");
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;

    // 初期化
    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "";
    document.getElementById("related-videos-list").innerHTML = "<p style='color:#aaa;'>関連動画を読み込んでいます...</p>";
    document.getElementById("comments-sentinel").style.display = "flex";

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

      // 【右側】関連動画の描画（右側に固定表示）
      let relVideos = data.recommendedVideos || [];
      if (relVideos.length === 0) {
        const fallbackSearch = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent(data.author || "人気動画")}&limit=20`);
        relVideos = Array.isArray(fallbackSearch) ? fallbackSearch : (fallbackSearch.results || []);
      }
      this.renderRelatedVideos(relVideos);

      // 【左側】コメントの初回ロード開始
      await this.loadMoreComments();

    } catch (err) {
      document.getElementById("watch-title").textContent = "動画の読み込みに失敗しました。";
    }
  },

  // 右側：関連動画一覧のレンダリング
  renderRelatedVideos(videos) {
    const list = document.getElementById("related-videos-list");
    if (!videos || videos.length === 0) {
      list.innerHTML = "<p style='color:#aaa;'>関連動画はありません。</p>";
      return;
    }

    list.innerHTML = videos.map(v => `
      <div class="related-item" onclick="app.navigate('/?v=${v.videoId || v.id}')">
        <div class="related-thumb-box">
          <img src="${v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/mqdefault.jpg`}" loading="lazy" alt="">
        </div>
        <div style="flex:1;min-width:0;">
          <div class="related-title" title="${this.escape(v.title)}">${this.escape(v.title)}</div>
          <div class="related-channel">${this.escape(v.author || v.channel?.name || '')}</div>
          <div class="related-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')}</div>
        </div>
      </div>
    `).join("");
  },

  // コメントの無限スクロール追加読み込み
  async loadMoreComments() {
    if (this.isFetchingComments || !this.currentVideoId) return;
    this.isFetchingComments = true;
    const list = document.getElementById("comments-list");

    try {
      const endpoint = this.commentsToken
        ? `/api/v1/comments/${this.currentVideoId}?continuation=${encodeURIComponent(this.commentsToken)}`
        : `/api/v1/comments/${this.currentVideoId}?limit=50`;

      const data = await this.fetchApi(endpoint);
      
      if (!this.commentsToken) {
        const count = data.commentCount || data.comments?.length || 0;
        document.getElementById("comments-count-title").textContent = `コメント ${count ? count.toLocaleString() + ' 件' : ''}`;
      }

      this.commentsToken = data.continuation || null;
      this.appendCommentsToList(data.comments || [], list);

      if (!this.commentsToken) {
        document.getElementById("comments-sentinel").style.display = "none";
      }
    } catch (err) {
      if (!this.commentsToken) list.innerHTML = "<p style='color:#aaa;'>コメントはありません。</p>";
      document.getElementById("comments-sentinel").style.display = "none";
    } finally {
      this.isFetchingComments = false;
    }
  },

  appendCommentsToList(comments, container) {
    if (!comments || comments.length === 0) return;

    const html = comments.map(c => `
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

    container.insertAdjacentHTML("beforeend", html);
  },

  // =================================================================
  // 3. チャンネル画面（初回 ＆ 無限追加読み込み）
  // =================================================================
  async loadChannelView(channelTarget) {
    this.switchView("view-channel");
    this.currentChannelTarget = channelTarget;
    this.channelToken = null;

    const grid = document.getElementById("channel-video-grid");
    grid.innerHTML = "";
    document.getElementById("channel-sentinel").style.display = "flex";

    try {
      const data = await this.fetchApi(`/api/v1/channels/${encodeURIComponent(channelTarget)}?limit=50`);

      document.getElementById("channel-page-name").textContent = data.author || "";
      document.getElementById("channel-page-subs").textContent = data.subCount ? data.subCount.toLocaleString() + " 人の登録者" : "";
      document.getElementById("channel-page-desc").textContent = data.description || "";
      document.getElementById("channel-page-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";

      const banner = data.authorBanners?.[0]?.url;
      document.getElementById("channel-banner").style.backgroundImage = banner ? `url('${banner}')` : "none";

      this.channelToken = data.continuation || null;
      this.appendVideosToGrid(data.latestVideos || [], grid);

      if (!this.channelToken) {
        document.getElementById("channel-sentinel").style.display = "none";
      }
    } catch (err) {
      grid.innerHTML = `<p style="color:#ff4e4e;padding:20px;">チャンネルの取得に失敗しました: ${err.message}</p>`;
      document.getElementById("channel-sentinel").style.display = "none";
    }
  },

  async loadMoreChannelVideos() {
    if (this.isFetchingChannel || !this.channelToken) return;
    this.isFetchingChannel = true;
    const grid = document.getElementById("channel-video-grid");

    try {
      const data = await this.fetchApi(`/api/v1/channels/${encodeURIComponent(this.currentChannelTarget)}?continuation=${encodeURIComponent(this.channelToken)}`);
      this.channelToken = data.continuation || null;
      this.appendVideosToGrid(data.latestVideos || [], grid);

      if (!this.channelToken) {
        document.getElementById("channel-sentinel").style.display = "none";
      }
    } catch (err) {
      document.getElementById("channel-sentinel").style.display = "none";
    } finally {
      this.isFetchingChannel = false;
    }
  },

  smartChannelNav(target) {
    if (target.startsWith("UC") || target.startsWith("@")) {
      this.navigate(`/?channel=${encodeURIComponent(target)}`);
    } else {
      this.navigate(`/?q=${encodeURIComponent(target)}`);
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
