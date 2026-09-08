const API_BASE = "https://api-nemu-utube.myproxy0108.workers.dev";

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

  // 無限スクロール用トークン
  feedToken: null,
  commentsToken: null,
  channelToken: null,

  // 重複防止フラグ
  isFetchingFeed: false,
  isFetchingComments: false,
  isFetchingChannel: false,

  // ★【新機能】ショート動画スワイプ管理キュー
  shortsQueue: [],
  currentShortIndex: 0,
  shortsSequenceParams: null,
  isFetchingShortsBatch: false,
  touchStartY: 0,

  init() {
    this.bindEvents();
    this.setupInfiniteScroll();
    this.setupShortsSwipeEvents();
    this.handleRoute();
    window.addEventListener("popstate", () => this.handleRoute());
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

  // 汎用 API 取得
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

  // ルーティング判定（通常動画 vs ショート動画 vs チャンネル vs 検索）
  handleRoute() {
    const params = new URLSearchParams(window.location.search);
    const shortId = params.get("short") || params.get("shorts");
    const videoId = params.get("v");
    const query = params.get("q");
    const channelId = params.get("channel");

    // ショート動画を開く場合
    if (shortId || window.location.pathname.startsWith("/shorts")) {
      const pathShortId = window.location.pathname.replace(/^\/shorts\/?/, "").split("/")[0];
      this.loadShortsView(shortId || pathShortId || null);
    } 
    // 通常動画を開く場合
    else if (videoId) {
      this.loadWatchView(videoId);
    } 
    // チャンネルを開く場合
    else if (channelId) {
      this.loadChannelView(channelId);
    } 
    // 検索を行う場合
    else if (query) {
      document.getElementById("search-input").value = query;
      this.loadSearchView(query);
    } 
    // ホーム
    else {
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

    // ショート画面以外ならショートプレイヤーを停止
    if (viewId !== "view-shorts") {
      document.getElementById("shorts-player").src = "";
    }
    // 通常再生画面以外なら通常プレイヤーを停止
    if (viewId !== "view-watch") {
      document.getElementById("nocookie-player").src = "";
    }
  },

  // =================================================================
  // ★ 【新機能】ショート動画 (Shorts) スワイプ＆無限シーケンス制御
  // =================================================================

  // ショートフィードの起動
  loadInitialShorts() {
    this.navigate("/?shorts=true");
  },

  async loadShortsView(shortId) {
    this.switchView("view-shorts");
    this.shortsQueue = [];
    this.currentShortIndex = 0;
    this.shortsSequenceParams = null;

    document.getElementById("shorts-title").textContent = "ショート動画を読み込んでいます...";
    document.getElementById("shorts-channel-name").textContent = "";
    document.getElementById("shorts-channel-avatar").src = "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
    document.getElementById("shorts-likes").textContent = "高評価";
    document.getElementById("shorts-comments-count").textContent = "コメント";

    try {
      const endpoint = shortId ? `/api/v1/shorts/${shortId}` : `/api/v1/shorts`;
      const data = await this.fetchApi(endpoint);

      if (data.type === "shorts" && data.current) {
        // 現在の動画をキューの先頭に登録
        this.shortsQueue.push(data.current);

        // 次にスワイプすると流れてくる動画シーケンスをキューに追加
        if (data.sequence && data.sequence.length > 0) {
          data.sequence.forEach(s => this.shortsQueue.push(s));
        }

        this.shortsSequenceParams = data.sequenceParams || null;
        this.renderCurrentShort();
      }
    } catch (err) {
      document.getElementById("shorts-title").textContent = "ショート動画の取得に失敗しました。";
    }
  },

  // 現在のインデックスのショート動画を描画・再生
  renderCurrentShort() {
    const item = this.shortsQueue[this.currentShortIndex];
    if (!item) return;

    // 縦型ループ再生埋め込み
    const player = document.getElementById("shorts-player");
    const targetEmbed = item.embedUrl || `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&controls=0&loop=1&playlist=${item.id}`;
    if (player.src !== targetEmbed) {
      player.src = targetEmbed;
    }

    document.getElementById("shorts-title").textContent = item.title || "";
    document.getElementById("shorts-channel-name").textContent = item.author || "YouTube Creator";
    document.getElementById("shorts-channel-name").onclick = () => this.smartChannelNav(item.authorId || item.author);
    document.getElementById("shorts-channel-avatar").src = item.authorThumbnails?.[0]?.url || "https://www.gstatic.com/youtube/img/creator/avatar/creator_avatar_default.png";
    document.getElementById("shorts-channel-avatar").onclick = () => this.smartChannelNav(item.authorId || item.author);
    document.getElementById("shorts-likes").textContent = item.likeCount || "高評価";
    document.getElementById("shorts-comments-count").textContent = item.commentCount || "コメント";

    // URLを更新（リロードせず履歴のみ）
    window.history.replaceState({}, "", `/?short=${item.id}`);

    // キューの残りが少なくなったら、裏で次の動画シーケンスを追加取得（無限スワイプ）
    if (this.shortsQueue.length - this.currentShortIndex <= 3 && this.shortsSequenceParams && !this.isFetchingShortsBatch) {
      this.fetchMoreShortsSequence();
    }
  },

  // 次のショート動画へスワイプ
  nextShort() {
    if (this.currentShortIndex < this.shortsQueue.length - 1) {
      this.currentShortIndex++;
      this.renderCurrentShort();
    } else if (this.shortsSequenceParams) {
      this.fetchMoreShortsSequence().then(() => {
        if (this.currentShortIndex < this.shortsQueue.length - 1) {
          this.currentShortIndex++;
          this.renderCurrentShort();
        }
      });
    }
  },

  // 前のショート動画へ戻る
  prevShort() {
    if (this.currentShortIndex > 0) {
      this.currentShortIndex--;
      this.renderCurrentShort();
    }
  },

  // 次のシーケンスを追加取得
  async fetchMoreShortsSequence() {
    if (this.isFetchingShortsBatch || !this.shortsSequenceParams) return;
    this.isFetchingShortsBatch = true;

    try {
      const data = await this.fetchApi(`/api/v1/shorts/sequence?sequenceParams=${encodeURIComponent(this.shortsSequenceParams)}`);
      if (data.sequence && data.sequence.length > 0) {
        data.sequence.forEach(s => {
          if (!this.shortsQueue.some(x => x.id === s.id)) {
            this.shortsQueue.push(s);
          }
        });
        this.shortsSequenceParams = data.nextSequenceParams || data.sequenceParams || null;
      }
    } catch (e) {
    } finally {
      this.isFetchingShortsBatch = false;
    }
  },

  // スワイプ操作・マウスホイール・キーボードのイベントリスナー
  setupShortsSwipeEvents() {
    const area = document.getElementById("shorts-touch-area");

    // 1. マウスホイール（下で次、上で前）
    let wheelTimeout = null;
    area.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (wheelTimeout) return;
      wheelTimeout = setTimeout(() => { wheelTimeout = null; }, 400);

      if (e.deltaY > 30) {
        this.nextShort();
      } else if (e.deltaY < -30) {
        this.prevShort();
      }
    }, { passive: false });

    // 2. スマホ・タブレットのタッチスワイプ（指を上に払うと次）
    area.addEventListener("touchstart", (e) => {
      this.touchStartY = e.touches[0].clientY;
    }, { passive: true });

    area.addEventListener("touchend", (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const diffY = this.touchStartY - touchEndY;
      if (diffY > 60) {
        this.nextShort(); // 上にスワイプ ➔ 次のショート
      } else if (diffY < -60) {
        this.prevShort(); // 下にスワイプ ➔ 前のショート
      }
    }, { passive: true });

    // 3. キーボードの上下矢印キー
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

  // ショート用コメントドロワー開閉
  async toggleShortsComments() {
    const drawer = document.getElementById("shorts-comment-drawer");
    const list = document.getElementById("shorts-comments-list");
    const current = this.shortsQueue[this.currentShortIndex];

    if (drawer.style.display !== "none") {
      drawer.style.display = "none";
      return;
    }

    drawer.style.display = "flex";
    list.innerHTML = "<p style='color:#aaa;'>コメントを読み込んでいます...</p>";

    if (!current) return;
    try {
      const data = await this.fetchApi(`/api/v1/comments/${current.id}?limit=30`);
      if (!data.comments || data.comments.length === 0) {
        list.innerHTML = "<p style='color:#aaa;'>コメントはありません。</p>";
        return;
      }
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
    } catch (e) {
      list.innerHTML = "<p style='color:#ff4e4e;'>コメントの取得に失敗しました。</p>";
    }
  },

  // =================================================================
  // 通常機能（ホーム・検索・通常動画再生・チャンネル・無限スクロール）
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
          if (document.getElementById("view-feed").style.display !== "none" && this.feedToken && !this.isFetchingFeed) this.loadMoreFeed();
          else if (document.getElementById("view-watch").style.display !== "none" && this.commentsToken && !this.isFetchingComments) this.loadMoreComments();
          else if (document.getElementById("view-channel").style.display !== "none" && this.channelToken && !this.isFetchingChannel) this.loadMoreChannelVideos();
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
      if (!this.feedToken) document.getElementById("feed-sentinel").style.display = "none";
    } catch (err) {
      document.getElementById("feed-sentinel").style.display = "none";
    } finally {
      this.isFetchingFeed = false;
    }
  },

  // 動画カードのクリック時判定（通常動画 vs ショート動画の自動判別）
  appendVideosToGrid(videos, container) {
    if (!videos || videos.length === 0) return;

    const html = videos.map(v => {
      const thumb = v.videoThumbnails?.[0]?.url || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId || v.id}/hqdefault.jpg`;
      const duration = v.lengthSeconds ? this.formatTime(v.lengthSeconds) : (v.duration || "");
      const author = v.author || v.channel?.name || "YouTube Creator";
      const authorTarget = v.authorId || v.channel?.id || author;
      const vId = v.videoId || v.id;

      // 60秒以下、またはタイトルに #shorts があればショート画面へ誘導
      const isShort = (v.lengthSeconds && v.lengthSeconds <= 60) || (v.title && v.title.toLowerCase().includes("#shorts"));
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
    }).join("");

    container.insertAdjacentHTML("beforeend", html);
  },

  // 通常動画再生 (Watch)
  async loadWatchView(videoId) {
    this.switchView("view-watch");
    this.currentVideoId = videoId;
    this.commentsToken = null;

    const player = document.getElementById("nocookie-player");
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;

    document.getElementById("watch-title").textContent = "読み込み中...";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("comments-list").innerHTML = "";
    document.getElementById("related-videos-list").innerHTML = "<p style='color:#aaa;'>関連動画を読み込んでいます...</p>";
    document.getElementById("comments-sentinel").style.display = "flex";

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

      let relVideos = data.recommendedVideos || [];
      if (relVideos.length === 0) {
        const fallback = await this.fetchApi(`/api/v1/search?q=${encodeURIComponent(data.author || "人気動画")}&limit=20`);
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
    if (!videos || videos.length === 0) { list.innerHTML = "<p style='color:#aaa;'>関連動画はありません。</p>"; return; }

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
        : `/api/v1/comments/${this.currentVideoId}?limit=50`;

      const data = await this.fetchApi(endpoint);
      if (!this.commentsToken) {
        const count = data.commentCount || data.comments?.length || 0;
        document.getElementById("comments-count-title").textContent = `コメント ${count ? count.toLocaleString() + ' 件' : ''}`;
      }
      this.commentsToken = data.continuation || null;
      this.appendCommentsToList(data.comments || [], list);
      if (!this.commentsToken) document.getElementById("comments-sentinel").style.display = "none";
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

  // チャンネル画面
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
      this.appendVideosToGrid(data.latestVideos || [], grid);
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
