// =================================================================
// ⚙️ 設定：あなたの Cloudflare Worker URL を記述してください
// =================================================================
const API_BASE = "https://api-yt.myproxy0108.workers.dev"; // ← 必要に応じて変更

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
  currentChannelTab: "videos", // "videos", "shorts", "playlists", "home"

  // 無限スクロール用トークン
  feedToken: null,
  commentsToken: null,
  channelToken: null,

  // 3の倍数で余った動画を保持するバッファ
  videoBuffer: [],

  isFetchingFeed: false,
  isFetchingComments: false,
  isFetchingChannel: false,

  // ショート動画管理
  rootShortId: null,
  shortsQueue: [],
  currentShortIndex: 0,
  shortStartTime: 0,
  userInteractedWithCurrent: false,
  isFetchingDynamicShorts: false,
  isShortsMuted: true,
  shortDataCache: new Map(), // 0ms遷移用の先読みキャッシュ

  // いいね管理
  isMainLiked: false,
  isMainDisliked: false,
  mainLikesOriginal: 0,
  isShortsLiked: false,
  isShortsDisliked: false,

  init() {
    this.bindEvents();
    this.setupInfiniteScroll();
    this.setupShortsSwipeEvents();
    this.setupShortsPlayerEvents();
    this.handleRoute();
    window.addEventListener("popstate", () => this.handleRoute());
  },

  bindEvents() {
    const searchForm = document.getElementById("search-form");
    if (searchForm) {
      searchForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = document.getElementById("search-input").value.trim();
        if (q) this.navigate(`/?q=${encodeURIComponent(q)}`);
      });
    }

    const logoLink = document.getElementById("logo-link");
    if (logoLink) {
      logoLink.addEventListener("click", (e) => {
        e.preventDefault();
        const input = document.getElementById("search-input");
        if (input) input.value = "";
        this.navigate("/");
      });
    }
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
    const channelTab = params.get("tab") || "videos";

    if (shortId || isShortsFeedReq) {
      this.loadShortsView(shortId);
    } else if (videoId) {
      this.loadWatchView(videoId);
    } else if (channelId) {
      this.currentChannelTab = channelTab;
      this.loadChannelView(channelId, channelTab);
    } else if (query) {
      const input = document.getElementById("search-input");
      if (input) input.value = query;
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
    const target = document.getElementById(viewId);
    if (target) target.style.display = "block";
    window.scrollTo(0, 0);

    if (viewId !== "view-shorts") {
      const sp = document.getElementById("shorts-player");
      if (sp) sp.src = "";
      const drawer = document.getElementById("shorts-comment-drawer");
      if (drawer) drawer.style.display = "none";
    }
    if (viewId !== "view-watch") {
      const wp = document.getElementById("nocookie-player");
      if (wp) wp.src = "";
    }
  },

  // =================================================================
  // ★ ショート動画：自動再生＆超高速先読み
  // =================================================================
  loadInitialShorts() {
    this.navigate("/?shorts=true");
  },

  setupShortsPlayerEvents() {
    const player = document.getElementById("shorts-player");
    if (player) {
      // iframeロード完了時に postMessage を送って確実に自動再生
      player.addEventListener("load", () => {
        try {
          player.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
        } catch (e) {}
      });
    }
  },

  toggleShortsMute() {
    this.isShortsMuted = !this.isShortsMuted;
    const player = document.getElementById("shorts-player");
    if (player && player.contentWindow) {
      const cmd = this.isShortsMuted ? "mute" : "unMute";
      player.contentWindow.postMessage(JSON.stringify({ event: "command", func: cmd, args: "" }), "*");
    }
    const muteBtn = document.getElementById("shorts-mute-btn");
    if (muteBtn) {
      muteBtn.textContent = this.isShortsMuted ? "🔇 消音中" : "🔊 音声ON";
    }
  },

  async loadShortsView(shortId) {
    this.switchView("view-shorts");
    this.rootShortId = shortId;
    this.shortsQueue = [];
    this.currentShortIndex = 0;
    this.shortStartTime = Date.now();
    this.userInteractedWithCurrent = false;

    document.getElementById("shorts-title").textContent = "ショート動画を読み込んでいます...";
    document.getElementById("shorts-channel-name").textContent = "";
    document.getElementById("shorts-channel-avatar").src = "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
    document.getElementById("shorts-likes").textContent = "高評価";
    document.getElementById("shorts-comments-count").textContent = "コメント";

    this.resetShortsLikes();

    // 先読みキャッシュにあれば即再生（0ms）
    const cacheKey = shortId || "root";
    if (this.shortDataCache.has(cacheKey)) {
      const cached = this.shortDataCache.get(cacheKey);
      this.populateShortsQueue(cached);
      this.renderCurrentShort();
      return;
    }

    try {
      const endpoint = shortId ? `/api/v1/shorts/${shortId}` : `/api/v1/shorts`;
      const data = await this.fetchApi(endpoint);

      if (data.current) {
        this.shortDataCache.set(cacheKey, data);
        this.populateShortsQueue(data);
        this.renderCurrentShort();
      } else {
        throw new Error("ショートデータが空です");
      }
    } catch (err) {
      document.getElementById("shorts-title").textContent = "ショート動画の取得に失敗しました。";
    }
  },

  populateShortsQueue(data) {
    if (!this.rootShortId) this.rootShortId = data.current.id;
    if (!this.shortsQueue.some(x => x.id === data.current.id)) {
      this.shortsQueue.push(data.current);
    }
    if (data.sequence && data.sequence.length > 0) {
      data.sequence.forEach(s => {
        if (!this.shortsQueue.some(x => x.id === s.id)) {
          this.shortsQueue.push(s);
        }
      });
      // 次の候補をバックグラウンド先読み
      this.prefetchNextShorts(data.sequence);
    }
  },

  prefetchNextShorts(sequenceList) {
    sequenceList.forEach(s => {
      if (!this.shortDataCache.has(s.id)) {
        this.fetchApi(`/api/v1/shorts/${s.id}`).then(d => {
          if (d && d.current) this.shortDataCache.set(s.id, d);
        }).catch(() => {});
      }
    });
  },

  renderCurrentShort() {
    const item = this.shortsQueue[this.currentShortIndex];
    if (!item) return;

    this.resetShortsLikes();
    this.shortStartTime = Date.now();
    this.userInteractedWithCurrent = false;

    const player = document.getElementById("shorts-player");
    // playsinline=1, enablejsapi=1, rel=0 を付加して自動再生
    const targetEmbed = item.embedUrl || `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&mute=${this.isShortsMuted ? '1' : '0'}&controls=0&loop=1&playlist=${item.id}&playsinline=1&enablejsapi=1&rel=0`;
    
    if (player && player.src !== targetEmbed) {
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
  },

  async nextShort() {
    const currentItem = this.shortsQueue[this.currentShortIndex];
    const watchDuration = Date.now() - this.shortStartTime;

    const isInterested = watchDuration >= 3000 || this.userInteractedWithCurrent;
    if (isInterested && currentItem && !this.isFetchingDynamicShorts) {
      this.fetchAndInjectRelatedShorts(currentItem.id);
    }

    if (this.currentShortIndex < this.shortsQueue.length - 1) {
      this.currentShortIndex++;
      this.renderCurrentShort();
    } else {
      await this.recoverFromRootShort();
    }
  },

  async fetchAndInjectRelatedShorts(targetId) {
    this.isFetchingDynamicShorts = true;
    try {
      let data = this.shortDataCache.get(targetId);
      if (!data) {
        data = await this.fetchApi(`/api/v1/shorts/${targetId}`);
        if (data.current) this.shortDataCache.set(targetId, data);
      }
      if (data.sequence && data.sequence.length > 0) {
        const newOnes = data.sequence.filter(s => !this.shortsQueue.some(x => x.id === s.id));
        if (newOnes.length > 0) {
          this.shortsQueue.splice(this.currentShortIndex + 1, 0, ...newOnes);
          this.prefetchNextShorts(newOnes);
        }
      }
    } catch (e) {
    } finally {
      this.isFetchingDynamicShorts = false;
    }
  },

  async recoverFromRootShort() {
    if (!this.rootShortId) return;
    try {
      const data = await this.fetchApi(`/api/v1/shorts/${this.rootShortId}`);
      if (data.sequence && data.sequence.length > 0) {
        data.sequence.forEach(s => {
          if (!this.shortsQueue.some(x => x.id === s.id)) {
            this.shortsQueue.push(s);
          }
        });
        if (this.currentShortIndex < this.shortsQueue.length - 1) {
          this.currentShortIndex++;
          this.renderCurrentShort();
        }
      }
    } catch (e) {}
  },

  prevShort() {
    if (this.currentShortIndex > 0) {
      this.currentShortIndex--;
      this.renderCurrentShort();
    }
  },

  setupShortsSwipeEvents() {
    const area = document.getElementById("shorts-touch-area") || document.getElementById("view-shorts");
    if (!area) return;

    let wheelTimeout = null;
    area.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (wheelTimeout) return;
      wheelTimeout = setTimeout(() => { wheelTimeout = null; }, 300);

      if (e.deltaY > 15) this.nextShort();
      else if (e.deltaY < -15) this.prevShort();
    }, { passive: false });

    area.addEventListener("touchstart", (e) => {
      this.touchStartY = e.touches[0].clientY;
    }, { passive: true });

    area.addEventListener("touchend", (e) => {
      const diffY = this.touchStartY - e.changedTouches[0].clientY;
      if (diffY > 35) this.nextShort();
      else if (diffY < -35) this.prevShort();
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      const viewShorts = document.getElementById("view-shorts");
      if (viewShorts && viewShorts.style.display !== "none") {
        if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); this.nextShort(); }
        else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); this.prevShort(); }
      }
    });
  },

  async toggleShortsComments() {
    this.userInteractedWithCurrent = true;
    const drawer = document.getElementById("shorts-comment-drawer");
    const list = document.getElementById("shorts-comments-list");
    const current = this.shortsQueue[this.currentShortIndex];

    if (!drawer) return;
    if (drawer.style.display !== "none") {
      drawer.style.display = "none";
      return;
    }

    drawer.style.display = "flex";
    if (list) list.innerHTML = "<p style='color:#aaa;padding:10px;'>コメントを読み込んでいます...</p>";

    if (!current) return;
    try {
      const data = await this.fetchApi(`/api/v1/comments/${current.id}?limit=30`);
      if (!data.comments || data.comments.length === 0) {
        if (list) list.innerHTML = "<p style='color:#aaa;padding:10px;'>コメントはありません。</p>";
        return;
      }
      if (list) {
        list.innerHTML = data.comments.map(c => `
          <div style="display:flex;gap:10px;margin-bottom:12px;">
            <img src="${c.authorThumbnails?.[0]?.url || 'https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png'}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;">
            <div style="font-size:12px;">
              <b>${this.escape(c.author)}</b> <span style="color:#aaa;">${c.publishedText}</span>
              <div style="margin-top:2px;font-size:13px;line-height:1.3;">${this.escape(c.content)}</div>
              <div style="color:#aaa;margin-top:4px;">👍 ${c.likeCount || 0}</div>
            </div>
          </div>
        `).join("");
      }
    } catch (e) {
      if (list) list.innerHTML = "<p style='color:#ff4e4e;padding:10px;'>コメントの取得に失敗しました。</p>";
    }
  },

  // =================================================================
  // いいね インタラクション
  // =================================================================
  toggleLike(target) {
    if (target === "main") {
      const btn = document.getElementById("main-like-btn");
      const textEl = document.getElementById("watch-likes-text");
      const dislikeBtn = document.getElementById("main-dislike-btn");

      this.isMainLiked = !this.isMainLiked;
      if (this.isMainLiked) {
        if (btn) btn.classList.add("liked");
        if (dislikeBtn) dislikeBtn.classList.remove("disliked");
        this.isMainDisliked = false;
        if (textEl) textEl.textContent = (this.mainLikesOriginal + 1).toLocaleString();
      } else {
        if (btn) btn.classList.remove("liked");
        if (textEl) textEl.textContent = this.mainLikesOriginal ? this.mainLikesOriginal.toLocaleString() : "高評価";
      }
    } else if (target === "shorts") {
      this.userInteractedWithCurrent = true;
      const circle = document.getElementById("shorts-like-circle");
      const dislikeCircle = document.getElementById("shorts-dislike-circle");

      this.isShortsLiked = !this.isShortsLiked;
      if (this.isShortsLiked) {
        if (circle) circle.classList.add("liked");
        if (dislikeCircle) dislikeCircle.classList.remove("disliked");
        this.isShortsDisliked = false;
      } else {
        if (circle) circle.classList.remove("liked");
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
        if (btn) btn.classList.add("disliked");
        if (likeBtn) likeBtn.classList.remove("liked");
        this.isMainLiked = false;
        if (textEl) textEl.textContent = this.mainLikesOriginal ? this.mainLikesOriginal.toLocaleString() : "高評価";
      } else {
        if (btn) btn.classList.remove("disliked");
      }
    } else if (target === "shorts") {
      const circle = document.getElementById("shorts-dislike-circle");
      const likeCircle = document.getElementById("shorts-like-circle");

      this.isShortsDisliked = !this.isShortsDisliked;
      if (this.isShortsDisliked) {
        if (circle) circle.classList.add("disliked");
        if (likeCircle) likeCircle.classList.remove("liked");
        this.isShortsLiked = false;
      } else {
        if (circle) circle.classList.remove("disliked");
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
  // 無限スクロール
  // =================================================================
  setupInfiniteScroll() {
    const observerOptions = { root: null, rootMargin: "800px", threshold: 0 };

    const feedSentinel = document.getElementById("feed-sentinel");
    if (feedSentinel) {
      new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this.feedToken && !this.isFetchingFeed) this.loadMoreFeed();
      }, observerOptions).observe(feedSentinel);
    }

    const commentsSentinel = document.getElementById("comments-sentinel");
    if (commentsSentinel) {
      new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this.commentsToken && !this.isFetchingComments) this.loadMoreComments();
      }, observerOptions).observe(commentsSentinel);
    }

    const channelSentinel = document.getElementById("channel-sentinel");
    if (channelSentinel) {
      new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this.channelToken && !this.isFetchingChannel) this.loadMoreChannelVideos();
      }, observerOptions).observe(channelSentinel);
    }

    let scrollTimeout = null;
    window.addEventListener("scroll", () => {
      if (scrollTimeout) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;
        if (scrollBottom >= docHeight - 800) {
          if (document.getElementById("view-feed")?.style.display !== "none" && this.feedToken && !this.isFetchingFeed) {
            this.loadMoreFeed();
          } else if (document.getElementById("view-watch")?.style.display !== "none" && this.commentsToken && !this.isFetchingComments) {
            this.loadMoreComments();
          } else if (document.getElementById("view-channel")?.style.display !== "none" && this.channelToken && !this.isFetchingChannel) {
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

  async loadHomeView() {
    this.switchView("view-feed");
    this.currentQuery = "おすすめ";
    this.feedToken = null;
    this.videoBuffer = [];
    const grid = document.getElementById("video-grid");
    if (grid) grid.innerHTML = "";
    const sentinel = document.getElementById("feed-sentinel");
    if (sentinel) sentinel.style.display = "flex";
    await this.loadMoreFeed();
  },

  async loadSearchView(query) {
    this.switchView("view-feed");
    this.currentQuery = query;
    this.feedToken = null;
    this.videoBuffer = [];
    const grid = document.getElementById("video-grid");
    if (grid) grid.innerHTML = "";
    const sentinel = document.getElementById("feed-sentinel");
    if (sentinel) sentinel.style.display = "flex";
    await this.loadMoreFeed();
  },

  async loadMoreFeed() {
    if (this.isFetchingFeed) return;
    this.isFetchingFeed = true;
    const grid = document.getElementById("video-grid");

    try {
      const endpoint = this.feedToken
        ? `/api/v1/search?continuation=${encodeURIComponent(this.feedToken)}`
        : `/api/v1/search?q=${encodeURIComponent(this.currentQuery)}&limit=30`;

      const data = await this.fetchApi(endpoint);
      const newVideos = Array.isArray(data) ? data : (data.results || []);
      
      this.feedToken = data.continuation || (Array.isArray(data) ? data.continuation : null) || null;

      const allVideos = [...this.videoBuffer, ...newVideos];
      this.videoBuffer = [];

      this.renderFeedWithShortsShelf(allVideos, grid);

      if (!this.feedToken && document.getElementById("feed-sentinel")) {
        document.getElementById("feed-sentinel").style.display = "none";
      }
    } catch (err) {
      if (grid) grid.insertAdjacentHTML("beforeend", `<p style="color:#ff4e4e;padding:20px;grid-column:1/-1;">検索エラー: ${err.message}</p>`);
      if (document.getElementById("feed-sentinel")) document.getElementById("feed-sentinel").style.display = "none";
    } finally {
      this.isFetchingFeed = false;
    }
  },

  renderFeedWithShortsShelf(videos, container) {
    if (!container) return;
    if (!videos || videos.length === 0) {
      if (!this.feedToken) container.insertAdjacentHTML("beforeend", "<p style='padding:20px;grid-column:1/-1;'>動画が見つかりませんでした。</p>");
      return;
    }

    const normalVideos = [];
    const shortVideos = [];

    videos.forEach(v => {
      const isShort = v.type === "short" || v.isShort || (v.lengthSeconds && v.lengthSeconds <= 61) || (v.title && v.title.toLowerCase().includes("#shorts"));
      if (isShort) {
        shortVideos.push(v);
      } else {
        normalVideos.push(v);
      }
    });

    let topCount = 0;
    if (normalVideos.length >= 6) topCount = 6;
    else if (normalVideos.length >= 3) topCount = 3;

    const firstBatch = normalVideos.slice(0, topCount);
    let html = firstBatch.map(v => this.buildVideoCardHtml(v)).join("");

    // ショート棚
    if (shortVideos.length > 0) {
      html += `
        <div class="shorts-shelf-container" style="grid-column: 1 / -1; margin: 15px 0;">
          <div class="shorts-shelf-header" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="#FF0000" d="M17.77 10.32l-1.2-.5L18 8.06a3.74 3.74 0 0 0-3.5-5.26 3.8 3.8 0 0 0-2.86 1.3L6.2 10.6a3.74 3.74 0 0 0 2.33 6.13 3.6 3.6 0 0 0 1.2.19l1.2.5-1.43 1.76a3.74 3.74 0 0 0 3.5 5.26 3.8 3.8 0 0 0 2.86-1.3l5.44-6.5a3.74 3.74 0 0 0-2.33-6.13zM10 14.5v-5l4.5 2.5-4.5 2.5z"/></svg>
            <h2 style="font-size:18px;margin:0;">ショート</h2>
          </div>
          <div class="shorts-shelf-scroll-row" style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;">
            ${shortVideos.slice(0, 10).map(s => this.buildShortShelfCardHtml(s)).join("")}
          </div>
        </div>
      `;
    }

    const remainingNormals = normalVideos.slice(topCount);
    let bottomCount = remainingNormals.length;
    if (this.feedToken) {
      bottomCount = Math.floor(remainingNormals.length / 3) * 3;
    }

    const secondBatch = remainingNormals.slice(0, bottomCount);
    html += secondBatch.map(v => this.buildVideoCardHtml(v)).join("");

    this.videoBuffer = remainingNormals.slice(bottomCount);
    container.insertAdjacentHTML("beforeend", html);
  },

  buildVideoCardHtml(v) {
    if (v.type === "playlist") {
      const pId = v.playlistId || v.id;
      const thumb = v.thumbnail || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      return `
        <div class="video-card" onclick="app.navigate('/?playlist=${pId}')">
          <div class="thumb-wrap">
            <img src="${thumb}" loading="lazy" alt="">
            <span class="duration-label" style="background:rgba(0,0,0,0.9);">≡ ${v.videoCount || 0} 本</span>
          </div>
          <div class="card-details">
            <div class="meta-right">
              <div class="v-title" title="${this.escape(v.title)}">🗂 ${this.escape(v.title)}</div>
              <div class="v-channel">${this.escape(v.author)}</div>
            </div>
          </div>
        </div>
      `;
    }

    const isShort = v.isShort || v.type === "short";
    const vId = v.videoId || v.id;
    const thumb = v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`;
    const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
    const author = v.author || v.channel?.name || "YouTube Creator";
    const authorTarget = v.authorId || v.channel?.id || author;

    // ショートの場合は直接ショートプレイヤーへ遷移
    const clickAction = isShort ? `app.navigate('/?short=${vId}')` : `app.navigate('/?v=${vId}')`;

    return `
      <div class="video-card" onclick="${clickAction}">
        <div class="thumb-wrap">
          <img src="${thumb}" loading="lazy" alt="">
          ${isShort ? `<span class="duration-label" style="background:#ff0055;">Shorts</span>` : (duration ? `<span class="duration-label">${duration}</span>` : "")}
        </div>
        <div class="card-details">
          <div class="meta-right">
            <div class="v-title" title="${this.escape(v.title)}">
              ${isShort ? `<span style="background:#ff0055;color:#fff;font-size:10px;padding:2px 4px;border-radius:3px;margin-right:4px;">ショート</span>` : ""}
              ${this.escape(v.title)}
            </div>
            <div class="v-channel" onclick="event.stopPropagation(); app.smartChannelNav('${this.escape(authorTarget)}')">${this.escape(author)}</div>
            <div class="v-sub-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')} ${v.publishedText || ''}</div>
          </div>
        </div>
      </div>
    `;
  },

  buildShortShelfCardHtml(s) {
    const vId = s.videoId || s.id;
    const thumb = s.videoThumbnails?.[0]?.url || s.thumbnail || `https://i.ytimg.com/vi/${vId}/oardefault.jpg`;
    return `
      <div class="shorts-shelf-card" onclick="app.navigate('/?short=${vId}')" style="flex:0 0 140px;cursor:pointer;">
        <div class="shorts-shelf-thumb" style="width:140px;aspect-ratio:9/16;border-radius:8px;overflow:hidden;background:#000;">
          <img src="${thumb}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;">
        </div>
        <div class="shorts-shelf-title" title="${this.escape(s.title)}" style="font-size:13px;margin-top:6px;font-weight:bold;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${this.escape(s.title)}</div>
        <div class="shorts-shelf-views" style="font-size:11px;color:#aaa;margin-top:2px;">${s.viewCountText || (s.viewCount ? s.viewCount.toLocaleString() + ' 回視聴' : '')}</div>
      </div>
    `;
  },

  // 通常再生画面 (Watch)
  async loadWatchView(videoId) {
    this.switchView("view-watch");
    this.currentVideoId = videoId;
    this.commentsToken = null;

    const player = document.getElementById("nocookie-player");
    if (player) player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1`;

    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "";
    document.getElementById("related-videos-list").innerHTML = "<p style='color:#aaa;'>関連動画を読み込んでいます...</p>";
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
    if (!list) return;
    if (!videos || videos.length === 0) { list.innerHTML = "<p style='color:#aaa;'>関連動画はありません。</p>"; return; }

    list.innerHTML = videos.map(v => {
      const isShort = v.isShort || v.type === "short";
      const vId = v.videoId || v.id;
      const clickAction = isShort ? `app.navigate('/?short=${vId}')` : `app.navigate('/?v=${vId}')`;
      return `
        <div class="related-item" onclick="${clickAction}">
          <div class="related-thumb-box">
            <img src="${v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${vId}/mqdefault.jpg`}" loading="lazy" alt="">
          </div>
          <div style="flex:1;min-width:0;">
            <div class="related-title" title="${this.escape(v.title)}">${this.escape(v.title)}</div>
            <div class="related-channel">${this.escape(v.author || v.channel?.name || '')}</div>
            <div class="related-stats">${v.viewCountText || (v.viewCount ? v.viewCount.toLocaleString() + ' 回視聴' : '')}</div>
          </div>
        </div>
      `;
    }).join("");
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

      if (!this.commentsToken && document.getElementById("comments-sentinel")) {
        document.getElementById("comments-sentinel").style.display = "none";
      }
    } catch (err) {
      if (!this.commentsToken && list) list.innerHTML = "<p style='color:#aaa;'>コメントはありません。</p>";
      if (document.getElementById("comments-sentinel")) document.getElementById("comments-sentinel").style.display = "none";
    } finally {
      this.isFetchingComments = false;
    }
  },

  appendCommentsToList(comments, container) {
    if (!container || !comments || comments.length === 0) return;
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
  // ★ チャンネル画面（ホーム・動画・ショート・プレイリスト対応）
  // =================================================================
  async loadChannelView(channelTarget, tab = "videos") {
    this.switchView("view-channel");
    this.currentChannelTarget = channelTarget;
    this.currentChannelTab = tab;
    this.channelToken = null;

    const grid = document.getElementById("channel-video-grid");
    if (grid) grid.innerHTML = "";
    const sentinel = document.getElementById("channel-sentinel");
    if (sentinel) sentinel.style.display = "flex";

    this.renderChannelTabsUI();

    try {
      const endpoint = `/api/v1/channels/${encodeURIComponent(channelTarget)}?tab=${encodeURIComponent(tab)}&limit=30`;
      const data = await this.fetchApi(endpoint);

      document.getElementById("channel-page-name").textContent = data.author || "";
      document.getElementById("channel-page-subs").textContent = data.subCount ? data.subCount.toLocaleString() + " 人の登録者" : "";
      document.getElementById("channel-page-desc").textContent = data.description || "";
      document.getElementById("channel-page-avatar").src = data.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
      const banner = data.authorBanners?.[0]?.url;
      const bannerEl = document.getElementById("channel-banner");
      if (bannerEl) bannerEl.style.backgroundImage = banner ? `url('${banner}')` : "none";

      this.channelToken = data.continuation || null;
      const items = data.contents || data.latestVideos || [];

      this.renderChannelContent(items, grid, tab);

      if (!this.channelToken && sentinel) sentinel.style.display = "none";
    } catch (err) {
      if (sentinel) sentinel.style.display = "none";
    }
  },

  renderChannelTabsUI() {
    // チャンネルヘッダー直下にタブUIが存在しなければ動的に生成
    let tabsContainer = document.getElementById("channel-tab-bar");
    if (!tabsContainer) {
      const parent = document.getElementById("view-channel");
      const grid = document.getElementById("channel-video-grid");
      if (parent && grid) {
        tabsContainer = document.createElement("div");
        tabsContainer.id = "channel-tab-bar";
        tabsContainer.style.cssText = "display:flex;gap:10px;margin:15px 0;border-bottom:1px solid #333;padding-bottom:8px;";
        parent.insertBefore(tabsContainer, grid);
      }
    }

    if (tabsContainer) {
      const tabs = [
        { id: "videos", name: "🎬 動画" },
        { id: "shorts", name: "📱 ショート" },
        { id: "playlists", name: "📑 プレイリスト" },
        { id: "home", name: "🏠 ホーム" }
      ];

      tabsContainer.innerHTML = tabs.map(t => `
        <button 
          class="channel-tab-btn ${this.currentChannelTab === t.id ? 'active' : ''}" 
          style="padding:8px 16px;background:${this.currentChannelTab === t.id ? '#00e5ff' : '#222'};color:${this.currentChannelTab === t.id ? '#000' : '#fff'};border:none;border-radius:20px;cursor:pointer;font-weight:bold;font-size:13px;"
          onclick="app.switchChannelTab('${t.id}')">
          ${t.name}
        </button>
      `).join("");
    }
  },

  switchChannelTab(tabId) {
    if (this.currentChannelTab === tabId) return;
    this.currentChannelTab = tabId;
    this.navigate(`/?channel=${encodeURIComponent(this.currentChannelTarget)}&tab=${tabId}`);
  },

  renderChannelContent(items, container, tab) {
    if (!container) return;
    if (!items || items.length === 0) {
      container.innerHTML = "<p style='padding:20px;grid-column:1/-1;color:#aaa;'>コンテンツがありません。</p>";
      return;
    }

    // ショートタブの場合は縦長ショートカードとして描画
    if (tab === "shorts") {
      const html = items.map(s => this.buildShortShelfCardHtml(s)).join("");
      container.insertAdjacentHTML("beforeend", html);
    } else {
      // 動画・ホーム・プレイリストは3の倍数で揃えて描画
      const count = this.channelToken ? Math.floor(items.length / 3) * 3 : items.length;
      const html = items.slice(0, count).map(v => this.buildVideoCardHtml(v)).join("");
      container.insertAdjacentHTML("beforeend", html);
    }
  },

  async loadMoreChannelVideos() {
    if (this.isFetchingChannel || !this.channelToken) return;
    this.isFetchingChannel = true;
    const grid = document.getElementById("channel-video-grid");
    const sentinel = document.getElementById("channel-sentinel");

    try {
      const endpoint = `/api/v1/channels/${encodeURIComponent(this.currentChannelTarget)}?tab=${encodeURIComponent(this.currentChannelTab)}&continuation=${encodeURIComponent(this.channelToken)}`;
      const data = await this.fetchApi(endpoint);
      this.channelToken = data.continuation || null;
      const items = data.contents || data.latestVideos || [];

      this.renderChannelContent(items, grid, this.currentChannelTab);

      if (!this.channelToken && sentinel) sentinel.style.display = "none";
    } catch (err) {
      if (sentinel) sentinel.style.display = "none";
    } finally {
      this.isFetchingChannel = false;
    }
  },

  smartChannelNav(target) {
    if (target.startsWith("UC") || target.startsWith("@")) {
      this.navigate(`/?channel=${encodeURIComponent(target)}&tab=videos`);
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

// グローバルスコープへのエクスポート
window.app = app;
document.addEventListener("DOMContentLoaded", () => app.init());
