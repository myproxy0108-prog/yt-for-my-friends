// =================================================================
// ⚙️ 設定：あなたの Cloudflare Worker URL を記述してください
// =================================================================
const API_BASE = "https://api-yt.myproxy0108.workers.dev"; // ← ここを書き換え
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
  isSearchingMode: false,

  // 無限スクロール用トークン
  feedToken: null,
  commentsToken: null,
  channelToken: null,

  isFetchingFeed: false,
  isFetchingComments: false,
  isFetchingChannel: false,

  // ★【無限スワイプ】ショート動画管理
  shortsQueue: [],
  currentShortIndex: 0,
  isFetchingShortsBatch: false,
  touchStartY: 0,

  // 高評価ボタン状態
  isMainLiked: false,
  isMainDisliked: false,
  mainLikesOriginal: 0,
  isShortsLiked: false,
  isShortsDisliked: false,

  init() {
    this.initTheme();
    this.bindEvents();
    this.setupInfiniteScroll();
    this.setupShortsSwipeEvents();
    this.handleRoute();
    window.addEventListener("popstate", () => this.handleRoute());
  },

  // =================================================================
  // 🌓 白黒テーマ切り替え
  // =================================================================
  initTheme() {
    const savedTheme = localStorage.getItem("yt-theme") || "dark";
    if (savedTheme === "light") {
      document.body.classList.add("light-theme");
      document.getElementById("theme-icon-dark").style.display = "none";
      document.getElementById("theme-icon-light").style.display = "block";
    }
  },

  toggleTheme() {
    const isLight = document.body.classList.toggle("light-theme");
    localStorage.setItem("yt-theme", isLight ? "light" : "dark");
    document.getElementById("theme-icon-dark").style.display = isLight ? "none" : "block";
    document.getElementById("theme-icon-light").style.display = isLight ? "block" : "none";
  },

  bindEvents() {
    document.getElementById("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = document.getElementById("search-input").value.trim();
      if (q) {
        this.navigate(`/?q=${encodeURIComponent(q)}`);
      }
    });

    document.getElementById("logo-link").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("search-input").value = "";
      this.navigate("/");
    });
  },

  async fetchApi(endpointPath) {
    const cleanBase = API_BASE.replace(/\/+$/, "");
    try {
      const res = await fetch(`${cleanBase}${endpointPath}`);
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
    const rawShortId = params.get("short") || params.get("shorts");
    const isValidShortId = rawShortId && rawShortId !== "true" && rawShortId !== "1" && rawShortId !== "feed" && rawShortId.length >= 10;
    const shortId = isValidShortId ? rawShortId : null;
    const isShortsFeedReq = rawShortId === "true" || rawShortId === "1" || window.location.pathname.startsWith("/shorts");

    const videoId = params.get("v");
    const query = params.get("q");
    const channelId = params.get("channel");

    if (shortId || isShortsFeedReq) {
      this.loadShortsView(shortId);
    } else if (videoId) {
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

    if (viewId !== "view-shorts") {
      document.getElementById("shorts-player").src = "";
      const drawer = document.getElementById("shorts-comment-drawer");
      if (drawer) drawer.style.display = "none";
    }
    if (viewId !== "view-watch") {
      document.getElementById("nocookie-player").src = "";
    }
  },

  // =================================================================
  // 📱 ショート動画制御（毎回次動画を再取得＆無限スワイプ）
  // =================================================================
  loadInitialShorts() {
    this.navigate("/?shorts=true");
  },

  async loadShortsView(shortId) {
    this.switchView("view-shorts");
    this.shortsQueue = [];
    this.currentShortIndex = 0;

    document.getElementById("shorts-title").textContent = "ショート動画を読み込んでいます...";
    document.getElementById("shorts-channel-name").textContent = "";
    document.getElementById("shorts-channel-avatar").src = "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
    document.getElementById("shorts-likes").textContent = "高評価";
    document.getElementById("shorts-comments-count").textContent = "コメント";

    this.resetShortsLikes();

    try {
      const endpoint = shortId ? `/api/v1/shorts/${shortId}` : `/api/v1/shorts`;
      const data = await this.fetchApi(endpoint);

      if (data.current) {
        this.shortsQueue.push(data.current);

        // 次の動画シーケンス（先読み3本）をキューに追加
        if (data.sequence && data.sequence.length > 0) {
          data.sequence.forEach(s => {
            if (!this.shortsQueue.some(x => x.id === s.id)) {
              this.shortsQueue.push(s);
            }
          });
        }

        this.renderCurrentShort();
      }
    } catch (err) {
      document.getElementById("shorts-title").textContent = "ショート動画の取得に失敗しました。";
    }
  },

  renderCurrentShort() {
    const item = this.shortsQueue[this.currentShortIndex];
    if (!item) return;

    this.resetShortsLikes();

    const player = document.getElementById("shorts-player");
    const targetEmbed = item.embedUrl || `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${item.id}`;
    if (player.src !== targetEmbed) {
      player.src = targetEmbed;
    }

    document.getElementById("shorts-title").textContent = item.title || "Shorts";
    document.getElementById("shorts-channel-name").textContent = item.author || "YouTube Creator";
    document.getElementById("shorts-channel-name").onclick = () => this.smartChannelNav(item.authorId || item.author);
    document.getElementById("shorts-channel-avatar").src = item.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
    document.getElementById("shorts-channel-avatar").onclick = () => this.smartChannelNav(item.authorId || item.author);
    document.getElementById("shorts-likes").textContent = item.likeCount || "高評価";
    document.getElementById("shorts-comments-count").textContent = item.commentCount || "コメント";

    window.history.replaceState({}, "", `/?short=${item.id}`);

    // ★【ユーザー要求通り】動画を開く/切り替えるたびに、その動画を起点に新しい次動画を取得してキューを補充★
    this.refreshNextShortsForCurrent(item.id);
  },

  // 現在のショート動画を起点に、毎回新しい次3本を取得してキューの先を上書き補充
  async refreshNextShortsForCurrent(currentVideoId) {
    if (this.isFetchingShortsBatch) return;
    this.isFetchingShortsBatch = true;

    try {
      const data = await this.fetchApi(`/api/v1/shorts/${currentVideoId}`);
      if (data && data.sequence && data.sequence.length > 0) {
        // すでに再生済みの動画を除外して、キューの末尾に追加
        data.sequence.forEach(s => {
          if (!this.shortsQueue.some(x => x.id === s.id)) {
            this.shortsQueue.push(s);
          }
        });
      }
    } catch (e) {
    } finally {
      this.isFetchingShortsBatch = false;
    }
  },

  // 下から上スワイプ（次へ）
  nextShort() {
    if (this.currentShortIndex < this.shortsQueue.length - 1) {
      this.currentShortIndex++;
      this.renderCurrentShort();
    } else {
      // キューの末尾に達した場合は現在IDで即座に再取得して進める
      const current = this.shortsQueue[this.currentShortIndex];
      if (current) {
        this.refreshNextShortsForCurrent(current.id).then(() => {
          if (this.currentShortIndex < this.shortsQueue.length - 1) {
            this.currentShortIndex++;
            this.renderCurrentShort();
          }
        });
      }
    }
  },

  // 上から下スワイプ（前へ戻る）
  prevShort() {
    if (this.currentShortIndex > 0) {
      this.currentShortIndex--;
      this.renderCurrentShort();
    }
  },

  setupShortsSwipeEvents() {
    const area = document.getElementById("shorts-touch-area");

    let wheelTimeout = null;
    area.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (wheelTimeout) return;
      wheelTimeout = setTimeout(() => { wheelTimeout = null; }, 300);

      if (e.deltaY > 15) {
        this.nextShort();
      } else if (e.deltaY < -15) {
        this.prevShort();
      }
    }, { passive: false });

    area.addEventListener("touchstart", (e) => {
      this.touchStartY = e.touches[0].clientY;
    }, { passive: true });

    area.addEventListener("touchend", (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const diffY = this.touchStartY - touchEndY;
      if (diffY > 35) {
        this.nextShort();
      } else if (diffY < -35) {
        this.prevShort();
      }
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      const viewShorts = document.getElementById("view-shorts");
      if (viewShorts && viewShorts.style.display !== "none") {
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          this.nextShort();
        } else if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          this.prevShort();
        }
      }
    });
  },

  async toggleShortsComments() {
    const drawer = document.getElementById("shorts-comment-drawer");
    const list = document.getElementById("shorts-comments-list");
    const current = this.shortsQueue[this.currentShortIndex];

    if (drawer.style.display !== "none") {
      drawer.style.display = "none";
      return;
    }

    drawer.style.display = "flex";
    list.innerHTML = "<p style='color:var(--text-secondary);padding:10px;'>コメントを読み込んでいます...</p>";

    if (!current) return;
    try {
      const data = await this.fetchApi(`/api/v1/comments/${current.id}?limit=30`);
      if (!data.comments || data.comments.length === 0) {
        list.innerHTML = "<p style='color:var(--text-secondary);padding:10px;'>コメントはありません。</p>";
        return;
      }
      list.innerHTML = data.comments.map(c => `
        <div style="display:flex;gap:10px;margin-bottom:12px;">
          <img src="${c.authorThumbnails?.[0]?.url || 'https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png'}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;" alt="">
          <div style="font-size:12px;">
            <b>${this.escape(c.author)}</b> <span style="color:var(--text-secondary);">${c.publishedText}</span>
            <div style="margin-top:2px;font-size:13px;line-height:1.3;">${this.escape(c.content)}</div>
            <div style="color:var(--text-secondary);margin-top:4px;">👍 ${c.likeCount || 0}</div>
          </div>
        </div>
      `).join("");
    } catch (e) {
      list.innerHTML = "<p style='color:#ff4e4e;padding:10px;'>コメントの取得に失敗しました。</p>";
    }
  },

  // =================================================================
  // 高評価・低評価ボタン（トグル処理）
  // =================================================================
  toggleLike(target) {
    if (target === "main") {
      const btn = document.getElementById("main-like-btn");
      const textEl = document.getElementById("watch-likes-text");
      const dislikeBtn = document.getElementById("main-dislike-btn");

      this.isMainLiked = !this.isMainLiked;
      if (this.isMainLiked) {
        btn.classList.add("liked");
        dislikeBtn.classList.remove("disliked");
        this.isMainDisliked = false;
        textEl.textContent = (this.mainLikesOriginal + 1).toLocaleString();
      } else {
        btn.classList.remove("liked");
        textEl.textContent = this.mainLikesOriginal ? this.mainLikesOriginal.toLocaleString() : "高評価";
      }
    } else if (target === "shorts") {
      const circle = document.getElementById("shorts-like-circle");
      const dislikeCircle = document.getElementById("shorts-dislike-circle");

      this.isShortsLiked = !this.isShortsLiked;
      if (this.isShortsLiked) {
        circle.classList.add("liked");
        dislikeCircle.classList.remove("disliked");
        this.isShortsDisliked = false;
      } else {
        circle.classList.remove("liked");
      }
    }
  },

  toggleDislike(target) {
    if (target === "main") {
      const btn = document.getElementById("main-dislike-btn");
      const likeBtn = document.getElementById("main-like-btn");
      const textEl = document.getElementById("watch-likes-text");

      this.isMainDisliked = !this.isMainDisliked;
      if (this.isMainDisliked) {
        btn.classList.add("disliked");
        likeBtn.classList.remove("liked");
        this.isMainLiked = false;
        textEl.textContent = this.mainLikesOriginal ? this.mainLikesOriginal.toLocaleString() : "高評価";
      } else {
        btn.classList.remove("disliked");
      }
    } else if (target === "shorts") {
      const circle = document.getElementById("shorts-dislike-circle");
      const likeCircle = document.getElementById("shorts-like-circle");

      this.isShortsDisliked = !this.isShortsDisliked;
      if (this.isShortsDisliked) {
        circle.classList.add("disliked");
        likeCircle.classList.remove("liked");
        this.isShortsLiked = false;
      } else {
        circle.classList.remove("disliked");
      }
    }
  },

  resetMainLikes(count) {
    this.isMainLiked = false;
    this.isMainDisliked = false;
    this.mainLikesOriginal = typeof count === "number" ? count : 0;
    const btn = document.getElementById("main-like-btn");
    const dislikeBtn = document.getElementById("main-dislike-btn");
    if (btn) btn.classList.remove("liked");
    if (dislikeBtn) dislikeBtn.classList.remove("disliked");
  },

  resetShortsLikes() {
    this.isShortsLiked = false;
    this.isShortsDisliked = false;
    const circle = document.getElementById("shorts-like-circle");
    const dislikeCircle = document.getElementById("shorts-dislike-circle");
    if (circle) circle.classList.remove("liked");
    if (dislikeCircle) dislikeCircle.classList.remove("disliked");
  },

  // =================================================================
  // 無限スクロール監視エンジン
  // =================================================================
  setupInfiniteScroll() {
    const observerOptions = { root: null, rootMargin: "800px", threshold: 0 };

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.feedToken && !this.isFetchingFeed) this.loadMoreFeed();
    }, observerOptions).observe(document.getElementById("feed-sentinel"));

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.commentsToken && !this.isFetchingComments) this.loadMoreComments();
    }, observerOptions).observe(document.getElementById("comments-sentinel"));

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.channelToken && !this.isFetchingChannel) this.loadMoreChannelVideos();
    }, observerOptions).observe(document.getElementById("channel-sentinel"));

    let scrollTimeout = null;
    window.addEventListener("scroll", () => {
      if (scrollTimeout) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;
        if (scrollBottom >= docHeight - 800) {
          if (document.getElementById("view-feed").style.display !== "none" && this.feedToken && !this.isFetchingFeed) {
            this.loadMoreFeed();
          } else if (document.getElementById("view-watch").style.display !== "none" && this.commentsToken && !this.isFetchingComments) {
            this.loadMoreComments();
          } else if (document.getElementById("view-channel").style.display !== "none" && this.channelToken && !this.isFetchingChannel) {
            this.loadMoreChannelVideos();
          }
        }
      }, 150);
    }, { passive: true });
  },

  search(category) {
    this.currentCategory = category;
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.textContent === category));
    const q = category === "すべて" ? "おすすめ" : category;
    this.navigate(`/?q=${encodeURIComponent(q)}`);
  },

  // 1. ホーム画面ロード（均等グリッド）
  async loadHomeView() {
    this.switchView("view-feed");
    this.isSearchingMode = false;
    this.currentQuery = "おすすめ";
    this.feedToken = null;
    const container = document.getElementById("video-feed-container");
    container.className = "video-grid";
    container.innerHTML = "";
    document.getElementById("feed-sentinel").style.display = "flex";
    await this.loadMoreFeed();
  },

  // 2. 検索画面ロード（本物同様の横長リストビュー）
  async loadSearchView(query) {
    this.switchView("view-feed");
    this.isSearchingMode = true;
    this.currentQuery = query;
    this.feedToken = null;
    const container = document.getElementById("video-feed-container");
    container.className = "search-results-list"; // リストビュー
    container.innerHTML = "";
    document.getElementById("feed-sentinel").style.display = "flex";
    await this.loadMoreFeed();
  },

  async loadMoreFeed() {
    if (this.isFetchingFeed) return;
    this.isFetchingFeed = true;
    const container = document.getElementById("video-feed-container");

    try {
      const endpoint = this.feedToken
        ? `/api/v1/search?continuation=${encodeURIComponent(this.feedToken)}`
        : `/api/v1/search?q=${encodeURIComponent(this.currentQuery)}&limit=30`;

      const data = await this.fetchApi(endpoint);
      const videos = Array.isArray(data) ? data : (data.results || []);
      this.feedToken = data.continuation || null;

      if (this.isSearchingMode) {
        this.renderSearchResults(videos, container);
      } else {
        this.renderHomeGrid(videos, container);
      }

      if (!this.feedToken) document.getElementById("feed-sentinel").style.display = "none";
    } catch (err) {
      document.getElementById("feed-sentinel").style.display = "none";
    } finally {
      this.isFetchingFeed = false;
    }
  },

  // ホーム時：均等グリッド描画
  renderHomeGrid(videos, container) {
    if (!videos || videos.length === 0) return;
    const html = videos.map(v => this.buildHomeVideoCardHtml(v)).join("");
    container.insertAdjacentHTML("beforeend", html);
  },

  // ★【要件2】検索時：本物の横長リストビュー ＋ 横1列ショート棚★
  renderSearchResults(videos, container) {
    if (!videos || videos.length === 0) return;

    const normalVideos = [];
    const shortVideos = [];

    videos.forEach(v => {
      const isShort = v.type === "short" || v.isShort || (v.lengthSeconds && v.lengthSeconds <= 60) || (v.title && v.title.toLowerCase().includes("#shorts"));
      if (isShort) {
        shortVideos.push(v);
      } else {
        normalVideos.push(v);
      }
    });

    // 最初の通常動画 3 本
    const firstBatch = normalVideos.slice(0, 3);
    let html = firstBatch.map(v => this.buildSearchListItemHtml(v)).join("");

    // ★【要件1】横1列ショート棚（はみ出し・空き地ゼロ）★
    if (shortVideos.length > 0 && !this.feedToken) {
      html += `
        <div class="shorts-shelf-container">
          <div class="shorts-shelf-header">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="#FF0000" d="M17.77 10.32l-1.2-.5L18 8.06a3.74 3.74 0 0 0-3.5-5.26 3.8 3.8 0 0 0-2.86 1.3L6.2 10.6a3.74 3.74 0 0 0 2.33 6.13 3.6 3.6 0 0 0 1.2.19l1.2.5-1.43 1.76a3.74 3.74 0 0 0 3.5 5.26 3.8 3.8 0 0 0 2.86-1.3l5.44-6.5a3.74 3.74 0 0 0-2.33-6.13zM10 14.5v-5l4.5 2.5-4.5 2.5z"/></svg>
            <h2>ショート</h2>
          </div>
          <div class="shorts-shelf-scroll-row">
            ${shortVideos.slice(0, 8).map(s => this.buildShortShelfCardHtml(s)).join("")}
          </div>
        </div>
      `;
    }

    // 残りの通常動画
    const secondBatch = normalVideos.slice(3);
    html += secondBatch.map(v => this.buildSearchListItemHtml(v)).join("");

    container.insertAdjacentHTML("beforeend", html);
  },

  buildHomeVideoCardHtml(v) {
    const thumb = v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/hqdefault.jpg`;
    const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
    const author = v.author || v.channel?.name || "YouTube Creator";
    const authorTarget = v.authorId || v.channel?.id || author;
    const vId = v.videoId || v.id;
    const isShort = v.type === "short" || v.isShort;
    const clickAction = isShort ? `app.navigate('/?short=${vId}')` : `app.navigate('/?v=${vId}')`;

    return `
      <div class="video-card" onclick="${clickAction}">
        <div class="thumb-wrap">
          <img src="${thumb}" loading="lazy" alt="">
          ${duration ? `<span class="duration-label">${duration}</span>` : ""}
        </div>
        <div class="card-details">
          <div class="meta-right">
            <div class="v-title" title="${this.escape(v.title)}">${isShort ? '📱 ' : ''}${this.escape(v.title)}</div>
            <div class="v-channel" onclick="event.stopPropagation(); app.smartChannelNav('${this.escape(authorTarget)}')">${this.escape(author)}</div>
            <div class="v-sub-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')} ${v.publishedText || ''}</div>
          </div>
        </div>
      </div>
    `;
  },

  buildSearchListItemHtml(v) {
    const thumb = v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/hqdefault.jpg`;
    const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
    const author = v.author || v.channel?.name || "YouTube Creator";
    const authorTarget = v.authorId || v.channel?.id || author;
    const vId = v.videoId || v.id;

    return `
      <div class="search-video-item" onclick="app.navigate('/?v=${vId}')">
        <div class="search-thumb-wrap">
          <img src="${thumb}" loading="lazy" alt="">
          ${duration ? `<span class="duration-label">${duration}</span>` : ""}
        </div>
        <div class="search-meta-wrap">
          <h3 class="search-v-title" title="${this.escape(v.title)}">${this.escape(v.title)}</h3>
          <div class="search-v-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')} ${v.publishedText || ''}</div>
          <div class="search-channel-row" onclick="event.stopPropagation(); app.smartChannelNav('${this.escape(authorTarget)}')">
            <span>${this.escape(author)}</span>
          </div>
          <div class="search-desc-snippet">${this.escape(v.description || "")}</div>
        </div>
      </div>
    `;
  },

  buildShortShelfCardHtml(s) {
    const vId = s.videoId || s.id;
    const thumb = s.videoThumbnails?.[0]?.url || s.thumbnail || `https://i.ytimg.com/vi/${vId}/oardefault.jpg`;
    return `
      <div class="shorts-shelf-card" onclick="app.navigate('/?short=${vId}')">
        <div class="shorts-shelf-thumb">
          <img src="${thumb}" loading="lazy" alt="">
        </div>
        <div class="shorts-shelf-title" title="${this.escape(s.title)}">${this.escape(s.title)}</div>
        <div class="shorts-shelf-views">${s.viewCountText || (s.viewCount ? s.viewCount.toLocaleString() + ' 回視聴' : '')}</div>
      </div>
    `;
  },

  // 3. 動画再生画面 (Watch)
  async loadWatchView(videoId) {
    this.switchView("view-watch");
    this.currentVideoId = videoId;
    this.commentsToken = null;

    const player = document.getElementById("nocookie-player");
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;

    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "";
    document.getElementById("related-videos-list").innerHTML = "<p style='color:var(--text-secondary);'>関連動画を読み込んでいます...</p>";
    document.getElementById("comments-sentinel").style.display = "flex";

    this.resetMainLikes(0);

    try {
      const data = await this.fetchApi(`/api/v1/videos/${videoId}`);

      document.getElementById("watch-title").textContent = data.title || "";
      document.getElementById("watch-channel-name").textContent = data.author || "";
      document.getElementById("watch-channel-name").onclick = () => this.smartChannelNav(data.authorId || data.author);
      document.getElementById("watch-channel-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      document.getElementById("watch-channel-avatar").onclick = () => this.smartChannelNav(data.authorId || data.author);
      document.getElementById("watch-channel-subs").textContent = data.subCountText || "";
      document.getElementById("watch-views").textContent = (data.viewCount || 0).toLocaleString() + " 回視聴";
      document.getElementById("watch-date").textContent = data.publishedText || "";
      document.getElementById("watch-description").textContent = data.description || "説明はありません。";

      const likesNum = data.likeCount || 0;
      document.getElementById("watch-likes-text").textContent = likesNum ? likesNum.toLocaleString() : "高評価";
      this.resetMainLikes(likesNum);

      let relVideos = data.recommendedVideos || [];
      if (relVideos.length === 0) {
        const fallback = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent(data.author || "人気動画")}&limit=12`);
        relVideos = Array.isArray(fallback) ? fallback : (fallback.results || []);
      }
      this.renderRelatedVideos(relVideos);

      await this.loadMoreComments();
    } catch (err) {
      document.getElementById("watch-title").textContent = "動画の読み込みに失敗しました。";
    }
  },

  renderRelatedVideos(videos) {
    const list = document.getElementById("related-videos-list");
    if (!videos || videos.length === 0) { list.innerHTML = "<p style='color:var(--text-secondary);'>関連動画はありません。</p>"; return; }

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

  async loadMoreComments() {
    if (this.isFetchingComments || !this.currentVideoId) return;
    this.isFetchingComments = true;
    const list = document.getElementById("comments-list");

    try {
      const endpoint = this.commentsToken
        ? `/api/v1/comments/${this.currentVideoId}?continuation=${encodeURIComponent(this.commentsToken)}`
        : `/api/v1/comments/${this.currentVideoId}?limit=30`;

      const data = await this.fetchApi(endpoint);
      if (!this.commentsToken) {
        const count = data.commentCount || data.comments?.length || 0;
        document.getElementById("comments-count-title").textContent = `コメント ${count ? count.toLocaleString() + ' 件' : ''}`;
      }

      this.commentsToken = data.continuation || null;
      this.appendCommentsToList(data.comments || [], list);

      if (!this.commentsToken) document.getElementById("comments-sentinel").style.display = "none";
    } catch (err) {
      if (!this.commentsToken) list.innerHTML = "<p style='color:var(--text-secondary);'>コメントはありません。</p>";
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

  // 4. チャンネル画面
  async loadChannelView(channelTarget) {
    this.switchView("view-channel");
    this.currentChannelTarget = channelTarget;
    this.channelToken = null;
    const grid = document.getElementById("channel-video-grid");
    grid.innerHTML = "";
    document.getElementById("channel-sentinel").style.display = "flex";

    try {
      const data = await this.fetchApi(`/api/v1/channels/${encodeURIComponent(channelTarget)}?limit=30`);
      document.getElementById("channel-page-name").textContent = data.author || "";
      document.getElementById("channel-page-subs").textContent = data.subCount ? data.subCount.toLocaleString() + " 人の登録者" : "";
      document.getElementById("channel-page-desc").textContent = data.description || "";
      document.getElementById("channel-page-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      const banner = data.authorBanners?.[0]?.url;
      document.getElementById("channel-banner").style.backgroundImage = banner ? `url('${banner}')` : "none";

      this.channelToken = data.continuation || null;
      const videos = data.latestVideos || [];
      const html = videos.map(v => this.buildHomeVideoCardHtml(v)).join("");
      grid.insertAdjacentHTML("beforeend", html);

      if (!this.channelToken) document.getElementById("channel-sentinel").style.display = "none";
    } catch (err) {
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
      const videos = data.latestVideos || [];
      const html = videos.map(v => this.buildHomeVideoCardHtml(v)).join("");
      grid.insertAdjacentHTML("beforeend", html);
      if (!this.channelToken) document.getElementById("channel-sentinel").style.display = "none";
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
