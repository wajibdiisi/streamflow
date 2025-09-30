/*
 * StreamFlow v2.0 - Live Streaming Lewat VPS
 * 
 * Custom Features & UI Components
 * Created by: Bang Tutorial
 * GitHub: https://github.com/bangtutorial

 * © 2025 Bang Tutorial - All rights reserved
 */

let selectedVideoData = null;
let currentOrientation = 'horizontal';
let isDropdownOpen = false;
const videoSelectorDropdown = document.getElementById('videoSelectorDropdown');
let desktopVideoPlayer = null;
let mobileVideoPlayer = null;
let streamKeyTimeout = null;
let isStreamKeyValid = true;
let currentPlatform = 'Custom';
function openNewStreamModal() {
  const modal = document.getElementById('newStreamModal');
  document.body.style.overflow = 'hidden';
  modal.classList.remove('hidden');
  const advancedSettingsContent = document.getElementById('advancedSettingsContent');
  const advancedSettingsToggle = document.getElementById('advancedSettingsToggle');
  if (advancedSettingsContent && advancedSettingsToggle) {
    advancedSettingsContent.classList.add('hidden');
    const icon = advancedSettingsToggle.querySelector('i');
    if (icon) icon.style.transform = '';
  }
  requestAnimationFrame(() => {
    modal.classList.add('active');
  });
  loadGalleryVideos();
  
  // Set default values every time modal opens
  setDefaultValues();
}

function setDefaultValues() {
  // Set default RTMP URL
  const rtmpInput = document.getElementById('rtmpUrl');
  if (rtmpInput) {
    rtmpInput.value = 'rtmp://a.rtmp.youtube.com/live2';
  }
  
  // Set default schedule time: server time + 3 minutes
  fetch('/api/server-time').then(r => r.json()).then(({ localISO }) => {
    if (localISO) {
      const base = new Date(localISO.replace('T', ' ') + ':00');
      base.setMinutes(base.getMinutes() + 3);
      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      const d = String(base.getDate()).padStart(2, '0');
      const hh = String(base.getHours()).padStart(2, '0');
      const mm = String(base.getMinutes()).padStart(2, '0');
      const iso = `${y}-${m}-${d}T${hh}:${mm}`;
      const sched = document.querySelector('input[type="datetime-local"]');
      if (sched) sched.value = iso;
    }
  }).catch(() => { });
}
function closeNewStreamModal() {
  const modal = document.getElementById('newStreamModal');
  document.body.style.overflow = 'auto';
  modal.classList.remove('active');
  resetModalForm();
  const advancedSettingsContent = document.getElementById('advancedSettingsContent');
  const advancedSettingsToggle = document.getElementById('advancedSettingsToggle');
  if (advancedSettingsContent && advancedSettingsToggle) {
    advancedSettingsContent.classList.add('hidden');
    const icon = advancedSettingsToggle.querySelector('i');
    if (icon) icon.style.transform = '';
  }
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200);
  if (desktopVideoPlayer) {
    desktopVideoPlayer.pause();
    desktopVideoPlayer.dispose();
    desktopVideoPlayer = null;
  }
  if (mobileVideoPlayer) {
    mobileVideoPlayer.pause();
    mobileVideoPlayer.dispose();
    mobileVideoPlayer = null;
  }
}
function toggleVideoSelector() {
  const dropdown = document.getElementById('videoSelectorDropdown');
  if (dropdown.classList.contains('hidden')) {
    dropdown.classList.remove('hidden');
    if (!dropdown.dataset.loaded) {
      loadGalleryVideos();
      loadFolderOptions();
        dropdown.dataset.loaded = 'true';
    }
    const searchInput = document.getElementById('videoSearchInput');
    if (searchInput) {
      setTimeout(() => searchInput.focus(), 10);
    }
  } else {
    dropdown.classList.add('hidden');
    const searchInput = document.getElementById('videoSearchInput');
    if (searchInput) {
      searchInput.value = '';
    }
  }
}
function selectVideo(video) {
  selectedVideoData = video;
  document.getElementById('selectedVideo').textContent = video.name;
  const videoSelector = document.querySelector('[onclick="toggleVideoSelector()"]');
  videoSelector.classList.remove('border-red-500');
  videoSelector.classList.add('border-gray-600');
  const desktopPreview = document.getElementById('videoPreview');
  const desktopEmptyPreview = document.getElementById('emptyPreview');
  const mobilePreview = document.getElementById('videoPreviewMobile');
  const mobileEmptyPreview = document.getElementById('emptyPreviewMobile');
  desktopPreview.classList.remove('hidden');
  mobilePreview.classList.remove('hidden');
  desktopEmptyPreview.classList.add('hidden');
  mobileEmptyPreview.classList.add('hidden');
  if (desktopVideoPlayer) {
    desktopVideoPlayer.pause();
    desktopVideoPlayer.dispose();
    desktopVideoPlayer = null;
  }
  if (mobileVideoPlayer) {
    mobileVideoPlayer.pause();
    mobileVideoPlayer.dispose();
    mobileVideoPlayer = null;
  }
  const desktopVideoContainer = document.getElementById('videoPreview');
  const mobileVideoContainer = document.getElementById('videoPreviewMobile');
  desktopVideoContainer.innerHTML = `
    <video id="videojs-preview-desktop" class="video-js vjs-default-skin vjs-big-play-centered" controls preload="auto">
      <source src="${video.url}" type="video/mp4">
    </video>
  `;
  mobileVideoContainer.innerHTML = `
    <video id="videojs-preview-mobile" class="video-js vjs-default-skin vjs-big-play-centered" controls preload="auto">
      <source src="${video.url}" type="video/mp4">
    </video>
  `;
  setTimeout(() => {
    desktopVideoPlayer = videojs('videojs-preview-desktop', {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: true
    });
    mobileVideoPlayer = videojs('videojs-preview-mobile', {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: true
    });
  }, 10);
  document.getElementById('videoSelectorDropdown').classList.add('hidden');
  const hiddenVideoInput = document.getElementById('selectedVideoId');
  if (hiddenVideoInput) {
    hiddenVideoInput.value = video.id;
  }
}

// Load folder options for video filtering
function loadFolderOptions() {
  const folderSelect = document.getElementById('videoFolderSelect');
  if (!folderSelect) return;
  
  // Get unique folders from videos
  const videos = window.allStreamVideos || [];
  const folders = [...new Set(videos.map(video => video.folder_path || 'Default'))].sort();
  
  // Clear existing options except "All folders"
  folderSelect.innerHTML = '<option value="all">All folders</option>';
  
  // Add folder options
  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder;
    folderSelect.appendChild(option);
  });
  
  // Add event listener for folder filter
  folderSelect.addEventListener('change', function() {
    filterVideos();
    updateClearFolderButton();
  });
  
  // Add event listener for clear folder button
  const clearFolderBtn = document.getElementById('clearFolderFilter');
  if (clearFolderBtn) {
    clearFolderBtn.addEventListener('click', function() {
      folderSelect.value = 'all';
      filterVideos();
      updateClearFolderButton();
    });
  }
}

// Update clear folder button visibility
function updateClearFolderButton() {
  const folderSelect = document.getElementById('videoFolderSelect');
  const clearBtn = document.getElementById('clearFolderFilter');
  
  if (folderSelect && clearBtn) {
    if (folderSelect.value === 'all') {
      clearBtn.classList.add('hidden');
    } else {
      clearBtn.classList.remove('hidden');
    }
  }
}

// Filter videos based on search, filter, folder, and sort
function filterVideos() {
  const searchTerm = document.getElementById('videoSearchInput')?.value.toLowerCase() || '';
  const filterType = document.getElementById('videoFilterSelect')?.value || 'all';
  const folderFilter = document.getElementById('videoFolderSelect')?.value || 'all';
  const sortType = document.getElementById('videoSortSelect')?.value || 'default';
  
  let filteredVideos = [...(window.allStreamVideos || [])];
  
  // Apply search filter
  if (searchTerm) {
    filteredVideos = filteredVideos.filter(video => 
      video.name.toLowerCase().includes(searchTerm)
    );
  }
  
  // Apply folder filter
  if (folderFilter !== 'all') {
    filteredVideos = filteredVideos.filter(video => 
      (video.folder_path || 'Default') === folderFilter
    );
  }
  
  // Apply usage filter
  switch (filterType) {
    case 'used_gt_0':
      filteredVideos = filteredVideos.filter(video => video.used_count > 0);
      break;
    case 'used_eq_0':
      filteredVideos = filteredVideos.filter(video => video.used_count === 0);
      break;
    case 'in_use':
      filteredVideos = filteredVideos.filter(video => video.in_use);
      break;
  }
  
  // Apply sorting
  switch (sortType) {
    case 'used_desc':
      filteredVideos.sort((a, b) => (b.used_count || 0) - (a.used_count || 0));
      break;
    case 'used_asc':
      filteredVideos.sort((a, b) => (a.used_count || 0) - (b.used_count || 0));
      break;
    default:
      // Keep original order
      break;
  }
  
  // Render filtered videos
  displayFilteredVideos(filteredVideos);
}
async function loadGalleryVideos() {
  try {
    const container = document.getElementById('videoListContainer');
    if (!container) {
      console.error("Video list container not found");
      return;
    }
    container.innerHTML = '<div class="text-center py-3"><i class="ti ti-loader animate-spin mr-2"></i>Loading videos...</div>';
    const response = await fetch('/api/stream/videos');
    const videos = await response.json();
    window.allStreamVideos = videos;
    displayFilteredVideos(videos);
    loadFolderOptions();
    const searchInput = document.getElementById('videoSearchInput');
    if (searchInput) {
      searchInput.removeEventListener('input', handleVideoSearch);
      searchInput.addEventListener('input', handleVideoSearch);
      setTimeout(() => searchInput.focus(), 10);
    } else {
      console.error("Search input element not found");
    }
  } catch (error) {
    console.error('Error loading gallery videos:', error);
    const container = document.getElementById('videoListContainer');
    if (container) {
      container.innerHTML = `
        <div class="text-center py-5 text-red-400">
          <i class="ti ti-alert-circle text-2xl mb-2"></i>
          <p>Failed to load videos</p>
          <p class="text-xs text-gray-500 mt-1">Please try again</p>
        </div>
      `;
    }
  }
}
function handleVideoSearch(e) {
  const searchTerm = e.target.value.toLowerCase().trim();
  console.log("Searching for:", searchTerm);
  if (!window.allStreamVideos) {
    console.error("No videos available for search");
    return;
  }
  // Use the unified filterVideos function
  filterVideos();
}
function displayFilteredVideos(videos) {
  const container = document.getElementById('videoListContainer');
  container.innerHTML = '';
  const controls = getVideoFilterControls();
  let list = Array.isArray(videos) ? [...videos] : [];
  // Apply filter
  if (controls.filter === 'used_gt_0') {
    list = list.filter(v => (v.used_count || 0) > 0);
  } else if (controls.filter === 'used_eq_0') {
    list = list.filter(v => (v.used_count || 0) === 0);
  } else if (controls.filter === 'in_use') {
    list = list.filter(v => !!v.in_use);
  }
  // Apply sort
  if (controls.sort === 'used_desc') {
    list.sort((a,b) => (b.used_count||0) - (a.used_count||0));
  } else if (controls.sort === 'used_asc') {
    list.sort((a,b) => (a.used_count||0) - (b.used_count||0));
  }
  if (videos && videos.length > 0) {
    list.forEach(video => {
      const button = document.createElement('button');
      button.type = 'button';
      const baseCls = 'w-full flex items-center space-x-3 p-2 rounded hover:bg-dark-600 transition-colors overflow-hidden';
      button.className = baseCls;
      if (video.in_use) {
        if (video.stream_status === 'live') {
          // Neon green highlighter effect for live streams
          button.style.background = 'linear-gradient(135deg, rgba(16,185,129,0.30), rgba(16,185,129,0.16))';
          button.style.boxShadow = 'inset 0 0 24px rgba(16,185,129,0.28)';
        } else if (video.stream_status === 'scheduled') {
          // Yellow background for scheduled streams
          button.style.background = 'linear-gradient(135deg, rgba(234,179,8,0.30), rgba(234,179,8,0.16))';
          button.style.boxShadow = 'inset 0 0 24px rgba(234,179,8,0.28)';
        }
      }
      button.onclick = () => selectVideo(video);
      button.innerHTML = `
        <div class="w-16 h-12 bg-dark-800 rounded flex-shrink-0 overflow-hidden">
          <img src="${video.thumbnail || '/images/default-thumbnail.jpg'}" alt="" 
            class="w-full h-full object-cover rounded" 
            onerror="this.src='/images/default-thumbnail.jpg'">
        </div>
        <div class="flex-1 min-w-0 ml-3">
          <p class="text-sm font-medium text-white truncate">${video.name}</p>
          <p class="text-xs text-gray-400">${video.resolution} • ${video.duration}</p>
          <div class="flex items-center space-x-2">
            <span class="text-xs ${video.used_count > 0 ? 'text-yellow-400' : 'text-gray-500'}">Used in ${video.used_count || 0} stream${(video.used_count||0) !== 1 ? 's' : ''} (total)</span>
            ${video.in_use ? (video.stream_status === 'live' ? 
              '<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-300 border border-green-500">Currently Used</span>' : 
              '<span class="text-[10px] px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-300 border border-yellow-500">Scheduled</span>') : ''}
          </div>
        </div>
      `;
      container.appendChild(button);
    });
  } else {
    container.innerHTML = `
      <div class="text-center py-5 text-gray-400">
        <i class="ti ti-search-off text-2xl mb-2"></i>
        <p>No matching videos found</p>
        <p class="text-xs text-gray-500 mt-1">Try different keywords</p>
      </div>
    `;
  }
}

function getVideoFilterControls() {
  const filterEl = document.getElementById('videoFilterSelect');
  const sortEl = document.getElementById('videoSortSelect');
  return {
    filter: filterEl ? filterEl.value : 'all',
    sort: sortEl ? sortEl.value : 'default'
  };
}
function resetModalForm() {
  const form = document.getElementById('newStreamForm');
  form.reset();
  selectedVideoData = null;
  document.getElementById('selectedVideo').textContent = 'Choose a video...';
  const desktopPreview = document.getElementById('videoPreview');
  const desktopEmptyPreview = document.getElementById('emptyPreview');
  const mobilePreview = document.getElementById('videoPreviewMobile');
  const mobileEmptyPreview = document.getElementById('emptyPreviewMobile');
  desktopPreview.classList.add('hidden');
  mobilePreview.classList.add('hidden');
  desktopEmptyPreview.classList.remove('hidden');
  mobileEmptyPreview.classList.remove('hidden');
  desktopPreview.querySelector('video source').src = '';
  mobilePreview.querySelector('video source').src = '';
  if (isDropdownOpen) {
    toggleVideoSelector();
  }
  
  // Re-set default values after reset
  setDefaultValues();
}
function initModal() {
  const modal = document.getElementById('newStreamModal');
  if (!modal) return;
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeNewStreamModal();
    }
  });
  
  if (videoSelectorDropdown) {
    document.addEventListener('click', (e) => {
      const isClickInsideDropdown = videoSelectorDropdown.contains(e.target);
      const isClickOnButton = e.target.closest('[onclick="toggleVideoSelector()"]');
      if (!isClickInsideDropdown && !isClickOnButton && isDropdownOpen) {
        toggleVideoSelector();
      }
    });
  }
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isDropdownOpen) {
        toggleVideoSelector();
      } else if (!modal.classList.contains('hidden')) {
        closeNewStreamModal();
      }
    }
  });
  modal.addEventListener('touchmove', (e) => {
    if (e.target === modal) {
      e.preventDefault();
    }
  }, { passive: false });
}
function setVideoOrientation(orientation) {
  currentOrientation = orientation;
  const buttons = document.querySelectorAll('[onclick^="setVideoOrientation"]');
  buttons.forEach(button => {
    if (button.getAttribute('onclick').includes(orientation)) {
      button.classList.add('bg-primary', 'border-primary', 'text-white');
      button.classList.remove('bg-dark-700', 'border-gray-600');
    } else {
      button.classList.remove('bg-primary', 'border-primary', 'text-white');
      button.classList.add('bg-dark-700', 'border-gray-600');
    }
  });
  updateResolutionDisplay();
}
function updateResolutionDisplay() {
  const select = document.getElementById('resolutionSelect');
  const option = select.options[select.selectedIndex];
  const resolution = option.getAttribute(`data-${currentOrientation}`);
  const quality = option.textContent;
  document.getElementById('currentResolution').textContent = `${resolution} (${quality})`;
}
document.addEventListener('DOMContentLoaded', () => {
  const resolutionSelect = document.getElementById('resolutionSelect');
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', updateResolutionDisplay);
    setVideoOrientation('horizontal');
  }
  const filterSelect = document.getElementById('videoFilterSelect');
  const sortSelect = document.getElementById('videoSortSelect');
  if (filterSelect) {
    filterSelect.addEventListener('change', () => {
      filterVideos();
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      filterVideos();
    });
  }
});
function toggleStreamKeyVisibility() {
  const streamKeyInput = document.getElementById('streamKey');
  const streamKeyToggle = document.getElementById('streamKeyToggle');
  if (streamKeyInput.type === 'password') {
    streamKeyInput.type = 'text';
    streamKeyToggle.className = 'ti ti-eye-off';
  } else {
    streamKeyInput.type = 'password';
    streamKeyToggle.className = 'ti ti-eye';
  }
}
document.addEventListener('DOMContentLoaded', function () {
  const platformSelector = document.getElementById('platformSelector');
  const platformDropdown = document.getElementById('platformDropdown');
  const rtmpInput = document.getElementById('rtmpUrl');
  if (!platformSelector || !platformDropdown || !rtmpInput) return;
  platformSelector.addEventListener('click', function (e) {
    e.stopPropagation();
    platformDropdown.classList.toggle('hidden');
  });
  const platformOptions = document.querySelectorAll('.platform-option');
  platformOptions.forEach(option => {
    option.addEventListener('click', function () {
      const platformUrl = this.getAttribute('data-url');
      const platformName = this.querySelector('span').textContent;
      rtmpInput.value = platformUrl;
      platformDropdown.classList.add('hidden');
      updatePlatformIcon(this.querySelector('i').className);
    });
  });
  document.addEventListener('click', function (e) {
    if (platformDropdown && !platformDropdown.contains(e.target) &&
      !platformSelector.contains(e.target)) {
      platformDropdown.classList.add('hidden');
    }
  });
  function updatePlatformIcon(iconClass) {
    const currentIcon = platformSelector.querySelector('i');
    const iconParts = iconClass.split(' ');
    const brandIconPart = iconParts.filter(part => part.startsWith('ti-'))[0];
    currentIcon.className = `ti ${brandIconPart} text-center`;
    if (brandIconPart.includes('youtube')) {
      currentIcon.classList.add('text-red-500');
    } else if (brandIconPart.includes('twitch')) {
      currentIcon.classList.add('text-purple-500');
    } else if (brandIconPart.includes('facebook')) {
      currentIcon.classList.add('text-blue-500');
    } else if (brandIconPart.includes('instagram')) {
      currentIcon.classList.add('text-pink-500');
    } else if (brandIconPart.includes('tiktok')) {
      currentIcon.classList.add('text-white');
    } else if (brandIconPart.includes('shopee')) {
      currentIcon.classList.add('text-orange-500');
    } else if (brandIconPart.includes('live-photo')) {
      currentIcon.classList.add('text-teal-500');
    }
  }
  if (typeof showToast !== 'function') {
    window.showToast = function (type, message) {
      console.log(`${type}: ${message}`);
    }
  }
  const streamKeyInput = document.getElementById('streamKey');
  if (streamKeyInput && rtmpInput) {
    rtmpInput.addEventListener('input', function () {
      const url = this.value.toLowerCase();
      if (url.includes('youtube.com')) {
        currentPlatform = 'YouTube';
      } else if (url.includes('facebook.com')) {
        currentPlatform = 'Facebook';
      } else if (url.includes('twitch.tv')) {
        currentPlatform = 'Twitch';
      } else if (url.includes('tiktok.com')) {
        currentPlatform = 'TikTok';
      } else if (url.includes('instagram.com')) {
        currentPlatform = 'Instagram';
      } else if (url.includes('shopee.io')) {
        currentPlatform = 'Shopee Live';
      } else if (url.includes('restream.io')) {
        currentPlatform = 'Restream.io';
      } else {
        currentPlatform = 'Custom';
      }
      if (streamKeyInput.value) {
        validateStreamKeyForPlatform(streamKeyInput.value, currentPlatform);
      }
    });
    streamKeyInput.addEventListener('input', function () {
      clearTimeout(streamKeyTimeout);
      const streamKey = this.value.trim();
      if (!streamKey) {
        return;
      }
      streamKeyTimeout = setTimeout(() => {
        validateStreamKeyForPlatform(streamKey, currentPlatform);
      }, 500);
    });
  }
});
function validateStreamKeyForPlatform(streamKey, platform) {
  if (!streamKey.trim()) {
    return;
  }
  fetch(`/api/streams/check-key?key=${encodeURIComponent(streamKey)}`)
    .then(response => response.json())
    .then(data => {
      const streamKeyInput = document.getElementById('streamKey');
      if (data.isInUse) {
        streamKeyInput.classList.add('border-red-500');
        streamKeyInput.classList.remove('border-gray-600', 'focus:border-primary');
        let errorMsg = document.getElementById('streamKeyError');
        if (!errorMsg) {
          errorMsg = document.createElement('div');
          errorMsg.id = 'streamKeyError';
          errorMsg.className = 'text-xs text-red-500 mt-1';
          streamKeyInput.parentNode.appendChild(errorMsg);
        }
        errorMsg.textContent = 'This stream key is already in use. Please use a different key.';
        isStreamKeyValid = false;
      } else {
        streamKeyInput.classList.remove('border-red-500');
        streamKeyInput.classList.add('border-gray-600', 'focus:border-primary');
        const errorMsg = document.getElementById('streamKeyError');
        if (errorMsg) {
          errorMsg.remove();
        }
        isStreamKeyValid = true;
      }
    })
    .catch(error => {
      console.error('Error validating stream key:', error);
    });
}
document.addEventListener('DOMContentLoaded', initModal);
