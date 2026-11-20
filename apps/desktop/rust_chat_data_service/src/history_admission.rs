//! Ephemeral parent-pipe admission. This is not a persistent authority store.
use crate::domain::{OwnerType, TopicKey};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootIdentity {
    realpath: PathBuf,
    device: String,
    inode: String,
}
impl RootIdentity {
    pub fn read(root: &Path) -> Result<Self> {
        #[cfg(windows)]
        let info = windows_file_information(root)?;
        let realpath = root.canonicalize()?;
        let meta = fs::metadata(&realpath)?;
        anyhow::ensure!(meta.is_dir(), "HISTORY_ROOT_INVALID");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                realpath,
                device: meta.dev().to_string(),
                inode: meta.ino().to_string(),
            })
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
            anyhow::ensure!(
                info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
                "HISTORY_ROOT_INVALID"
            );
            // Keep the full NTFS file index as a string, as on Unix. Never
            // round a physical identity through JavaScript's Number type.
            Ok(Self {
                realpath,
                device: info.dwVolumeSerialNumber.to_string(),
                inode: ((u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow))
                    .to_string(),
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = meta;
            anyhow::bail!("HISTORY_ROOT_IDENTITY_UNSUPPORTED: platform identity requires independent acceptance")
        }
    }
}

#[cfg(windows)]
fn windows_file_information(
    path: &Path,
) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetVolumeInformationByHandleW, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    // Open the object itself, including directories. Following a junction or
    // other reparse point would turn an alias into an authority identity.
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    anyhow::ensure!(
        info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "HISTORY_PATH_ALIAS"
    );
    let mut filesystem = [0u16; 32];
    if unsafe {
        GetVolumeInformationByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0,
            std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
            filesystem.as_mut_ptr(), filesystem.len() as u32)
    } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let length = filesystem.iter().position(|&c| c == 0).unwrap_or(filesystem.len());
    anyhow::ensure!(String::from_utf16_lossy(&filesystem[..length]) == "NTFS",
        "HISTORY_ROOT_IDENTITY_UNSUPPORTED: only NTFS physical identity is qualified");
    anyhow::ensure!(info.nFileIndexHigh != 0 || info.nFileIndexLow != 0,
        "HISTORY_ROOT_IDENTITY_UNSUPPORTED: file index unavailable");
    Ok(info)
}

fn reject_path_alias(meta: &fs::Metadata) -> Result<()> {
    anyhow::ensure!(!meta.file_type().is_symlink(), "HISTORY_PATH_ALIAS");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        anyhow::ensure!(
            meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "HISTORY_PATH_ALIAS"
        );
    }
    Ok(())
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    owner_type: OwnerType,
    owner_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    owner_type: Option<OwnerType>,
    owner_ids: Option<Vec<String>>,
    topic_ids: Option<Vec<String>>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    #[serde(default)]
    protect_all: bool,
    #[serde(default)]
    protected_topics: Vec<TopicKey>,
    #[serde(default)]
    protected_owners: Vec<Owner>,
    #[serde(default)]
    protected_scopes: Vec<Scope>,
    #[serde(default)]
    native_topics: Vec<TopicKey>,
    #[serde(default)]
    mirror_deleted_topics: Vec<TopicKey>,
    #[serde(default)]
    mirror_deleted_owners: Vec<Owner>,
}
impl Descriptor {
    fn protects(&self, key: &TopicKey) -> bool {
        self.protect_all
            || self.protected_topics.contains(key)
            || self
                .protected_owners
                .iter()
                .any(|o| o.owner_type == key.owner_type && o.owner_id == key.owner_id)
            || self.protected_scopes.iter().any(|s| {
                s.owner_type.is_none_or(|t| t == key.owner_type)
                    && s.owner_ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&key.owner_id))
                    && s.topic_ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&key.topic_id))
            })
    }
    fn scope_protects(&self, key: &TopicKey) -> bool {
        self.protected_scopes.iter().any(|s| {
            s.owner_type.is_none_or(|t| t == key.owner_type)
                && s.owner_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&key.owner_id))
                && s.topic_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&key.topic_id))
        })
    }
    fn scope_protects_owner(&self, owner_type: OwnerType, owner_id: &str) -> bool {
        self.protected_scopes.iter().any(|s| {
            s.owner_type.is_none_or(|t| t == owner_type)
                && s.owner_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| id == owner_id))
                && s.topic_ids.as_ref().is_none_or(|ids| !ids.is_empty())
        })
    }
    fn validate(&self) -> Result<()> {
        for key in self
            .protected_topics
            .iter()
            .chain(&self.native_topics)
            .chain(&self.mirror_deleted_topics)
        {
            validate_id(&key.owner_id)?;
            validate_id(&key.topic_id)?;
        }
        for owner in self
            .protected_owners
            .iter()
            .chain(&self.mirror_deleted_owners)
        {
            validate_id(&owner.owner_id)?;
        }
        for scope in &self.protected_scopes {
            for id in scope.owner_ids.iter().chain(&scope.topic_ids).flatten() {
                validate_id(id)?;
            }
        }
        // Native deletion fences may overlap these DB-only grants. Source scope
        // and full-root protection never can. The private host derives exact
        // NativeSync exclusions before adding any mirror deletion grant.
        for key in &self.mirror_deleted_topics {
            anyhow::ensure!(
                !self.protect_all && !self.scope_protects(key),
                "HISTORY_MIRROR_GRANT_PROTECTED_SCOPE"
            );
        }
        for owner in &self.mirror_deleted_owners {
            anyhow::ensure!(
                !self.protect_all && !self.scope_protects_owner(owner.owner_type, &owner.owner_id),
                "HISTORY_MIRROR_GRANT_PROTECTED_SCOPE"
            );
        }
        Ok(())
    }
}
struct AdmissionState {
    session: Option<String>,
    generation: u64,
    digest: String,
    state: &'static str,
    descriptor: Descriptor,
}
#[derive(Clone)]
pub struct HistoryAdmission {
    inner: Arc<RwLock<AdmissionState>>,
    connected: Arc<AtomicBool>,
    unknown_commit: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    repair_pending: Arc<AtomicBool>,
    root: RootIdentity,
    instance: Uuid,
    #[cfg(test)]
    fixture: bool,
}
pub struct HistoryEntityGuard {
    _state: OwnedRwLockReadGuard<AdmissionState>,
}

pub struct HistoryWriteGuard {
    _state: OwnedRwLockReadGuard<AdmissionState>,
    admission: HistoryAdmission,
    path: PathBuf,
}
impl Drop for HistoryWriteGuard {
    fn drop(&mut self) {
        trace("guardRelease", Some(self._state.generation));
    }
}
impl HistoryWriteGuard {
    pub fn trace(&self, event: &str) {
        trace(event, Some(self._state.generation));
    }

    pub fn check_path(&self, path: &Path) -> Result<()> {
        anyhow::ensure!(path == self.path, "HISTORY_GUARD_PATH_MISMATCH");
        self.admission.verify_root()?;
        strict_path(&self.admission.root.realpath, path, false)?;
        Ok(())
    }
    pub fn unknown_commit(&self) {
        self.admission.unknown_commit.store(true, Ordering::Release);
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    #[serde(rename = "type")]
    kind: String,
    request_id: String,
    op: String,
    instance_id: Uuid,
    session_id: String,
    root_identity: RootIdentity,
    generation: u64,
    digest: String,
    descriptor_json: Option<String>,
    prepared_digest: Option<String>,
}
impl HistoryAdmission {
    pub fn new(root: &Path, instance: Uuid) -> Result<Self> {
        Ok(Self {
            root: RootIdentity::read(root)?,
            instance,
            inner: Arc::new(RwLock::new(AdmissionState {
                session: None,
                generation: 0,
                digest: String::new(),
                state: "unknown",
                descriptor: Descriptor::default(),
            })),
            connected: Arc::new(AtomicBool::new(true)),
            unknown_commit: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            repair_pending: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            fixture: false,
        })
    }
    #[cfg(test)]
    pub fn fixture(root: &Path) -> Self {
        let mut a = Self::new(root, Uuid::new_v4()).unwrap();
        a.fixture = true;
        a
    }
    pub fn root_identity(&self) -> RootIdentity {
        self.root.clone()
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub fn pending(&self) -> bool {
        self.repair_pending.load(Ordering::Acquire) || self.unknown_commit.load(Ordering::Acquire)
    }
    pub fn mark_repair_pending(&self) {
        self.repair_pending.store(true, Ordering::Release);
    }
    fn verify_root(&self) -> Result<()> {
        anyhow::ensure!(
            RootIdentity::read(&self.root.realpath)? == self.root,
            "HISTORY_ROOT_IDENTITY_CHANGED"
        );
        Ok(())
    }
    pub async fn acquire(
        &self,
        key: &TopicKey,
        path: &Path,
        expected_generation: u64,
    ) -> Result<HistoryWriteGuard> {
        trace("guardRequest", Some(expected_generation));
        test_barrier("before-guard").await?;
        let state = self.inner.clone().read_owned().await;
        anyhow::ensure!(
            self.connected.load(Ordering::Acquire),
            "HISTORY_AUTHORITY_DISCONNECTED"
        );
        anyhow::ensure!(
            !self.unknown_commit.load(Ordering::Acquire),
            "HISTORY_COMMIT_UNKNOWN"
        );
        anyhow::ensure!(
            state.generation == expected_generation,
            "HISTORY_GENERATION_STALE"
        );
        #[cfg(test)]
        let fixture = self.fixture;
        #[cfg(not(test))]
        let fixture = false;
        if !fixture {
            anyhow::ensure!(state.state != "prepared", "HISTORY_AUTHORITY_PENDING");
            anyhow::ensure!(state.state == "active", "HISTORY_AUTHORITY_UNKNOWN");
            anyhow::ensure!(!state.descriptor.protects(key), "HISTORY_PROTECTED");
            anyhow::ensure!(
                state.descriptor.native_topics.contains(key),
                "HISTORY_NATIVE_IDENTITY_UNVERIFIED"
            );
        }
        self.verify_root()?;
        validate_id(&key.owner_id)?;
        validate_id(&key.topic_id)?;
        let expected = self
            .root
            .realpath
            .join("UserData")
            .join(&key.owner_id)
            .join("topics")
            .join(&key.topic_id)
            .join("history.json");
        anyhow::ensure!(path == expected, "HISTORY_PHYSICAL_IDENTITY_MISMATCH");
        strict_path(&self.root.realpath, path, false)?;
        if !fixture {
            verify_native(&self.root.realpath, key)?;
        }
        let guard = HistoryWriteGuard {
            _state: state,
            admission: self.clone(),
            path: expected,
        };
        guard.trace("guardAcquire");
        Ok(guard)
    }
    /// Mirror deletions cannot grant History writes or mint native identities.
    pub async fn acquire_entity(
        &self,
        owner: Option<(OwnerType, &str)>,
        topic: Option<&str>,
        expected_generation: u64,
    ) -> Result<HistoryEntityGuard> {
        let state = self.inner.clone().read_owned().await;
        anyhow::ensure!(
            self.connected.load(Ordering::Acquire),
            "HISTORY_AUTHORITY_DISCONNECTED"
        );
        anyhow::ensure!(
            !self.unknown_commit.load(Ordering::Acquire),
            "HISTORY_COMMIT_UNKNOWN"
        );
        anyhow::ensure!(state.state != "prepared", "HISTORY_AUTHORITY_PENDING");
        anyhow::ensure!(state.state == "active", "HISTORY_AUTHORITY_UNKNOWN");
        anyhow::ensure!(
            state.generation == expected_generation,
            "HISTORY_GENERATION_STALE"
        );
        self.verify_root()?;
        anyhow::ensure!(!state.descriptor.protect_all, "HISTORY_PROTECTED");
        if let Some((owner_type, owner_id)) = owner {
            validate_id(owner_id)?;
            if let Some(topic_id) = topic {
                validate_id(topic_id)?;
                let key = TopicKey {
                    owner_type,
                    owner_id: owner_id.into(),
                    topic_id: topic_id.into(),
                };
                let mirror_grant = state.descriptor.mirror_deleted_topics.contains(&key);
                anyhow::ensure!(
                    !state.descriptor.scope_protects(&key)
                        && (mirror_grant || !state.descriptor.protects(&key)),
                    "HISTORY_PROTECTED"
                );
                if mirror_grant {
                    let owner_deleted = state
                        .descriptor
                        .mirror_deleted_owners
                        .iter()
                        .any(|o| o.owner_type == owner_type && o.owner_id == owner_id);
                    if owner_deleted {
                        verify_deleted_owner(&self.root.realpath, owner_id)?;
                    } else {
                        verify_deleted_topic(&self.root.realpath, &key)?;
                    }
                } else {
                    anyhow::ensure!(
                        state.descriptor.native_topics.contains(&key),
                        "HISTORY_NATIVE_IDENTITY_UNVERIFIED"
                    );
                }
            } else {
                let d = &state.descriptor;
                let mirror_grant = d
                    .mirror_deleted_owners
                    .iter()
                    .any(|o| o.owner_type == owner_type && o.owner_id == owner_id);
                anyhow::ensure!(!d.scope_protects_owner(owner_type,owner_id) && (mirror_grant ||
                    (!d.protected_owners.iter().any(|o|o.owner_type==owner_type && o.owner_id==owner_id) && !d.protected_topics.iter().any(|t|t.owner_type==owner_type && t.owner_id==owner_id))),"HISTORY_PROTECTED");
                if d.mirror_deleted_owners
                    .iter()
                    .any(|o| o.owner_type == owner_type && o.owner_id == owner_id)
                {
                    verify_deleted_owner(&self.root.realpath, owner_id)?;
                } else {
                    anyhow::ensure!(
                        d.native_topics
                            .iter()
                            .any(|t| t.owner_type == owner_type && t.owner_id == owner_id),
                        "HISTORY_NATIVE_IDENTITY_UNVERIFIED"
                    );
                }
            }
        }
        Ok(HistoryEntityGuard { _state: state })
    }
    pub async fn disconnect(&self) {
        self.connected.store(false, Ordering::Release);
        let mut state = self.inner.write().await;
        state.state = "unknown";
    }
    pub async fn control(&self, value: Value) -> Value {
        let request_id = value.get("requestId").cloned().unwrap_or(Value::Null);
        let op = value.get("op").cloned().unwrap_or(Value::Null);
        let result = self.apply_control(value).await;
        let state = self.inner.read().await;
        if result.is_ok() && op == "prepare" {
            trace("prepareAck", Some(state.generation));
        }
        json!({"type":"historyAuthorityAck","requestId":request_id,"op":op,"ok":result.is_ok(),"instanceId":self.instance,"sessionId":state.session,"rootIdentity":self.root,"generation":state.generation,"digest":state.digest,"state":state.state,"settled":!self.unknown_commit.load(Ordering::Acquire),"error":result.err().map(|e|e.to_string()),"repairPending":self.pending()})
    }
    async fn apply_control(&self, value: Value) -> Result<()> {
        let c: Control = serde_json::from_value(value)?;
        anyhow::ensure!(
            !c.request_id.is_empty() && c.request_id.len() <= 128,
            "HISTORY_CONTROL_REQUEST_INVALID"
        );
        anyhow::ensure!(
            c.kind == "historyAuthority"
                && c.instance_id == self.instance
                && c.root_identity == self.root,
            "HISTORY_CONTROL_IDENTITY_MISMATCH"
        );
        self.verify_root()?;
        anyhow::ensure!(
            self.connected.load(Ordering::Acquire),
            "HISTORY_AUTHORITY_DISCONNECTED"
        );
        anyhow::ensure!(
            !c.session_id.is_empty() && c.session_id.len() <= 128,
            "HISTORY_CONTROL_SESSION_INVALID"
        );
        // prepare never takes reconcile_lock: all writers use reconcile -> admission.
        let mut state = self.inner.write().await;
        if let Some(session) = &state.session {
            anyhow::ensure!(*session == c.session_id, "HISTORY_CONTROL_SESSION_MISMATCH");
        }
        match c.op.as_str() {
            "prepare" => {
                anyhow::ensure!(
                    c.generation
                        == state
                            .generation
                            .checked_add(1)
                            .context("generation overflow")?,
                    "HISTORY_CONTROL_GENERATION_INVALID"
                );
                let raw = c.descriptor_json.context("descriptorJson required")?;
                anyhow::ensure!(
                    hex::encode(Sha256::digest(raw.as_bytes())) == c.digest,
                    "HISTORY_CONTROL_DIGEST_MISMATCH"
                );
                let descriptor: Descriptor = serde_json::from_str(&raw)?;
                descriptor.validate()?;
                // Prepared rejects every writer, which conservatively includes old union new.
                state.session = Some(c.session_id);
                state.generation = c.generation;
                state.digest = c.digest;
                state.descriptor = descriptor;
                state.state = "prepared";
                self.generation.store(state.generation, Ordering::Release);
                anyhow::ensure!(
                    !self.unknown_commit.load(Ordering::Acquire),
                    "HISTORY_COMMIT_UNKNOWN"
                );
            }
            "activate" => {
                anyhow::ensure!(
                    state.session.is_some()
                        && c.generation == state.generation
                        && state.state == "prepared",
                    "HISTORY_CONTROL_ACTIVATION_MISMATCH"
                );
                if let Some(raw) = c.descriptor_json {
                    anyhow::ensure!(
                        c.prepared_digest.as_deref() == Some(state.digest.as_str()),
                        "HISTORY_CONTROL_PREPARED_DIGEST_MISMATCH"
                    );
                    anyhow::ensure!(
                        state.descriptor.protect_all || c.digest == state.digest,
                        "HISTORY_CONTROL_FINAL_SCOPE_NOT_FENCED"
                    );
                    anyhow::ensure!(
                        hex::encode(Sha256::digest(raw.as_bytes())) == c.digest,
                        "HISTORY_CONTROL_DIGEST_MISMATCH"
                    );
                    let final_descriptor: Descriptor = serde_json::from_str(&raw)?;
                    final_descriptor.validate()?;
                    state.descriptor = final_descriptor;
                    state.digest = c.digest;
                } else {
                    anyhow::ensure!(c.digest == state.digest, "HISTORY_CONTROL_DIGEST_MISMATCH");
                }
                anyhow::ensure!(
                    !self.unknown_commit.load(Ordering::Acquire),
                    "HISTORY_COMMIT_UNKNOWN"
                );
                state.state = "active";
            }
            "inspect" => {
                anyhow::ensure!(
                    state.session.is_some()
                        && c.generation == state.generation
                        && c.digest == state.digest,
                    "HISTORY_CONTROL_INSPECT_MISMATCH"
                );
            }
            _ => anyhow::bail!("HISTORY_CONTROL_OPERATION_INVALID"),
        }
        Ok(())
    }
}
/// Existing HTTP and per-item error shapes share these conservative codes.
pub fn failure_code(error: &anyhow::Error) -> Option<&'static str> {
    let message = error.to_string();
    Some(if message.starts_with("HISTORY_PROTECTED") {
        "SYNC_WRITER_EXCLUDED"
    } else if message.starts_with("HISTORY_COMMIT_UNKNOWN") {
        "HISTORY_COMMIT_UNKNOWN"
    } else if message.starts_with("HISTORY_AUTHORITY_PENDING") {
        "HISTORY_AUTHORITY_PENDING"
    } else if message.starts_with("HISTORY_AUTHORITY_UNKNOWN")
        || message.starts_with("HISTORY_AUTHORITY_DISCONNECTED")
    {
        "HISTORY_AUTHORITY_UNKNOWN"
    } else if message.starts_with("HISTORY_GENERATION_STALE") {
        "HISTORY_GENERATION_STALE"
    } else if message.starts_with("HISTORY_") {
        "HISTORY_AUTHORITY_DENIED"
    } else {
        return None;
    })
}

fn validate_id(id: &str) -> Result<()> {
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 240
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "HISTORY_IDENTITY_INVALID"
    );
    Ok(())
}
fn strict_path(root: &Path, path: &Path, missing_ok: bool) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .context("history path outside root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        anyhow::ensure!(
            matches!(component, std::path::Component::Normal(_)),
            "HISTORY_PATH_UNSAFE"
        );
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                reject_path_alias(&meta)?;
                if current != path {
                    anyhow::ensure!(meta.is_dir(), "HISTORY_ANCESTOR_INVALID");
                } else {
                    anyhow::ensure!(meta.is_file(), "HISTORY_FILE_INVALID");
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        anyhow::ensure!(meta.nlink() == 1, "HISTORY_FILE_ALIAS");
                    }
                    #[cfg(windows)]
                    anyhow::ensure!(
                        windows_file_information(&current)?.nNumberOfLinks == 1,
                        "HISTORY_FILE_ALIAS"
                    );
                }
            }
            Err(e) if missing_ok && e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
/// Verify absence component-by-component; a symlink must never manufacture it.
fn absent_beneath(root: &Path, path: &Path) -> Result<bool> {
    let relative = path
        .strip_prefix(root)
        .context("HISTORY_PATH_OUTSIDE_ROOT")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        anyhow::ensure!(
            matches!(component, std::path::Component::Normal(_)),
            "HISTORY_PATH_UNSAFE"
        );
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                reject_path_alias(&meta)?;
                if current != path {
                    anyhow::ensure!(meta.is_dir(), "HISTORY_ANCESTOR_INVALID");
                } else {
                    return Ok(false);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(false)
}
fn verify_deleted_owner(root: &Path, owner_id: &str) -> Result<()> {
    for path in [
        root.join("Agents").join(owner_id).join("config.json"),
        root.join("AgentGroups").join(owner_id).join("config.json"),
        root.join("UserData").join(owner_id),
    ] {
        anyhow::ensure!(
            absent_beneath(root, &path)?,
            "HISTORY_MIRROR_OWNER_DELETE_UNVERIFIED"
        );
    }
    Ok(())
}
fn verify_deleted_topic(root: &Path, key: &TopicKey) -> Result<()> {
    let (kind, other) = match key.owner_type {
        OwnerType::Agent => ("Agents", "AgentGroups"),
        OwnerType::Group => ("AgentGroups", "Agents"),
    };
    let path = root.join(kind).join(&key.owner_id).join("config.json");
    strict_path(root, &path, false)?;
    anyhow::ensure!(
        absent_beneath(
            root,
            &root.join(other).join(&key.owner_id).join("config.json")
        )?,
        "HISTORY_OWNER_AMBIGUOUS"
    );
    let config: Value = serde_json::from_slice(&fs::read(path)?)?;
    anyhow::ensure!(
        config.is_object()
            && config
                .get("id")
                .is_none_or(|id| id.as_str() == Some(&key.owner_id))
            && config
                .get("_historyDeleting")
                .is_none_or(|v| v == false || v.is_null()),
        "HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED"
    );
    let deleted = config
        .get("_historyDeletedTopics")
        .and_then(Value::as_array)
        .context("HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED")?;
    let mut found = false;
    for id in deleted {
        let id = id
            .as_str()
            .context("HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED")?;
        validate_id(id)?;
        if id == key.topic_id {
            found = true;
        }
    }
    anyhow::ensure!(found, "HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED");
    let topics = config
        .get("topics")
        .and_then(Value::as_array)
        .context("HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED")?;
    let mut ids = std::collections::HashSet::new();
    for topic in topics {
        let id = topic
            .get("id")
            .and_then(Value::as_str)
            .context("HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED")?;
        validate_id(id)?;
        anyhow::ensure!(
            ids.insert(id.to_ascii_lowercase()) && !id.eq_ignore_ascii_case(&key.topic_id),
            "HISTORY_MIRROR_TOPIC_DELETE_UNVERIFIED"
        );
    }
    // A retained physical source is not a writer grant; reject aliases even for a DB-only tombstone.
    strict_path(
        root,
        &root
            .join("UserData")
            .join(&key.owner_id)
            .join("topics")
            .join(&key.topic_id)
            .join("history.json"),
        true,
    )?;
    Ok(())
}

fn verify_native(root: &Path, key: &TopicKey) -> Result<()> {
    let (kind, other) = match key.owner_type {
        OwnerType::Agent => ("Agents", "AgentGroups"),
        OwnerType::Group => ("AgentGroups", "Agents"),
    };
    let path = root.join(kind).join(&key.owner_id).join("config.json");
    strict_path(root, &path, false)?;
    match fs::symlink_metadata(root.join(other).join(&key.owner_id).join("config.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => anyhow::bail!("HISTORY_OWNER_AMBIGUOUS"),
    };
    let config: Value = serde_json::from_slice(&fs::read(path)?)?;
    anyhow::ensure!(
        config.is_object()
            && config
                .get("_historyDeleting")
                .is_none_or(|v| v == false || v.is_null()),
        "HISTORY_OWNER_DELETING"
    );
    anyhow::ensure!(
        config
            .get("id")
            .is_none_or(|v| v.as_str() == Some(&key.owner_id)),
        "HISTORY_OWNER_ID_MISMATCH"
    );
    if let Some(deleted) = config.get("_historyDeletedTopics") {
        let ids = deleted.as_array().context("invalid deleted topics")?;
        for id in ids {
            let id = id.as_str().context("invalid deleted topic")?;
            anyhow::ensure!(
                !id.eq_ignore_ascii_case(&key.topic_id),
                "HISTORY_TOPIC_DELETED"
            );
        }
    }
    let topics = config
        .get("topics")
        .and_then(Value::as_array)
        .context("HISTORY_NATIVE_TOPICS_INVALID")?;
    let mut ids = std::collections::HashSet::new();
    let mut found = false;
    for topic in topics {
        let id = topic
            .get("id")
            .and_then(Value::as_str)
            .context("HISTORY_NATIVE_TOPIC_INVALID")?;
        validate_id(id)?;
        anyhow::ensure!(
            ids.insert(id.to_ascii_lowercase()),
            "HISTORY_NATIVE_TOPIC_AMBIGUOUS"
        );
        if id == key.topic_id {
            found = true;
        }
    }
    let side_child = key.owner_type == OwnerType::Agent
        && regex::Regex::new(r"^sidechat_\d+_[0-9a-f]+$")?.is_match(&key.topic_id);
    if side_child {
        let marker_path = root
            .join("UserData")
            .join(&key.owner_id)
            .join("topics")
            .join(&key.topic_id)
            .join("sidechat-child.json");
        strict_path(root, &marker_path, false)?;
        let marker: Value = serde_json::from_slice(&fs::read(marker_path)?)?;
        anyhow::ensure!(
            marker.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && marker.get("ephemeral") == Some(&Value::Bool(true))
                && marker
                    .get("historyDeleting")
                    .is_none_or(|v| v == false || v.is_null())
                && marker.get("agentId").and_then(Value::as_str) == Some(&key.owner_id)
                && marker.get("topicId").and_then(Value::as_str) == Some(&key.topic_id),
            "HISTORY_SIDE_CHILD_UNVERIFIED"
        );
        match marker.get("parentTopicId") {
            Some(Value::Null) => {}
            Some(Value::String(parent)) if ids.contains(&parent.to_ascii_lowercase()) => {}
            _ => anyhow::bail!("HISTORY_SIDE_PARENT_UNVERIFIED"),
        }
    } else {
        anyhow::ensure!(found, "HISTORY_NATIVE_TOPIC_MISSING");
    }
    Ok(())
}

#[cfg(not(feature = "admission-test-hooks"))]
pub fn trace(_event: &str, _generation: Option<u64>) {}
#[cfg(feature = "admission-test-hooks")]
pub fn trace(event: &str, generation: Option<u64>) {
    use std::io::Write;
    if let Some(root) = std::env::var_os("VCP_CDS_TEST_BARRIER_DIR") {
        let record = json!({"event":event,"generation":generation}).to_string() + "\n";
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(PathBuf::from(root).join("events.ndjson"))
        {
            let _ = file.write_all(record.as_bytes());
        }
    }
}

#[cfg(not(feature = "admission-test-hooks"))]
pub fn test_commit_barrier(_point: &str) -> Result<()> {
    Ok(())
}
#[cfg(feature = "admission-test-hooks")]
pub fn test_commit_barrier(point: &str) -> Result<()> {
    let Some(root) = std::env::var_os("VCP_CDS_TEST_BARRIER_DIR") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    if !root.join(format!("{point}.arm")).is_file() {
        return Ok(());
    }
    // The production writer remains synchronous. block_in_place yields its Tokio
    // worker so private control can wait on this guard even on a one-CPU host.
    let wait = || -> Result<()> {
        fs::write(root.join(format!("{point}.entered")), b"entered")?;
        for _ in 0..6000 {
            if root.join(format!("{point}.release")).is_file() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        anyhow::bail!("TEST_BARRIER_TIMEOUT")
    };
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        tokio::task::block_in_place(wait)
    } else {
        wait()
    }
}

#[cfg(not(feature = "admission-test-hooks"))]
pub async fn test_barrier(_point: &str) -> Result<()> {
    Ok(())
}
#[cfg(feature = "admission-test-hooks")]
pub async fn test_barrier(point: &str) -> Result<()> {
    let Some(root) = std::env::var_os("VCP_CDS_TEST_BARRIER_DIR") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    if !root.join(format!("{point}.arm")).is_file() {
        return Ok(());
    }
    fs::write(root.join(format!("{point}.entered")), b"entered")?;
    for _ in 0..6000 {
        if root.join(format!("{point}.release")).is_file() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    anyhow::bail!("TEST_BARRIER_TIMEOUT")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;
    fn fixture() -> (TempDir, HistoryAdmission, TopicKey, PathBuf) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent_a".into(),
            topic_id: "topic_a".into(),
        };
        let path = root.join("UserData/agent_a/topics/topic_a/history.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"[]").unwrap();
        fs::create_dir_all(temp.path().join("Agents/agent_a")).unwrap();
        fs::write(
            temp.path().join("Agents/agent_a/config.json"),
            br#"{"id":"agent_a","topics":[{"id":"topic_a"}]}"#,
        )
        .unwrap();
        let admission = HistoryAdmission::new(temp.path(), Uuid::new_v4()).unwrap();
        (temp, admission, key, path)
    }
    fn request(a: &HistoryAdmission, op: &str, generation: u64, descriptor: Value) -> Value {
        let raw = serde_json::to_string(&descriptor).unwrap();
        json!({"type":"historyAuthority","requestId":"test","op":op,"instanceId":a.instance,"rootIdentity":a.root,"sessionId":"session-a","generation":generation,"digest":hex::encode(Sha256::digest(raw.as_bytes())),"descriptorJson":raw})
    }
    async fn active(a: &HistoryAdmission, key: &TopicKey) -> Value {
        let descriptor = json!({"nativeTopics":[key]});
        let prepare = request(a, "prepare", 1, descriptor.clone());
        assert_eq!(a.control(prepare).await["ok"], true);
        let mut activate = request(a, "activate", 1, descriptor);
        activate.as_object_mut().unwrap().remove("descriptorJson");
        assert_eq!(a.control(activate.clone()).await["ok"], true);
        activate
    }
    #[test]
    fn physical_root_identity_is_stable_and_rejects_regular_files() {
        let temp = TempDir::new().unwrap();
        let first = RootIdentity::read(temp.path()).unwrap();
        assert_eq!(RootIdentity::read(temp.path()).unwrap(), first);
        assert!(!first.device.is_empty() && !first.inode.is_empty());
        let file = temp.path().join("not-a-root");
        fs::write(&file, b"synthetic").unwrap();
        assert!(RootIdentity::read(&file).is_err());
    }
    #[tokio::test]
    async fn replacing_the_root_directory_cannot_reuse_control_identity() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("root");
        fs::create_dir(&root).unwrap();
        let a = HistoryAdmission::new(&root, Uuid::new_v4()).unwrap();
        fs::rename(&root, temp.path().join("original-root")).unwrap();
        fs::create_dir(&root).unwrap();
        assert_ne!(RootIdentity::read(&root).unwrap(), a.root_identity());
        let ack = a
            .control(request(&a, "prepare", 1, json!({"protectAll":true})))
            .await;
        assert_eq!(ack["ok"], false);
        assert!(ack["error"]
            .as_str()
            .unwrap()
            .contains("HISTORY_ROOT_IDENTITY_CHANGED"));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_junctions_cannot_supply_root_or_history_identity() {
        let (temp, a, key, path) = fixture();
        active(&a, &key).await;
        let topic = path.parent().unwrap();
        let target = temp.path().join("moved-topic");
        fs::rename(topic, &target).unwrap();
        let plain = |p: &Path| {
            let value = p.to_string_lossy();
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
        };
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J", &plain(topic), &plain(&target)])
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed");
        assert!(RootIdentity::read(topic).is_err());
        assert!(a.acquire(&key, &path, 1).await.is_err());
        // Remove only the test junction; never recurse through its target.
        fs::remove_dir(topic).unwrap();
        fs::rename(target, topic).unwrap();
        assert!(a.acquire(&key, &path, 1).await.is_ok());
    }
    #[test]
    fn mirror_deletion_grants_cannot_overlap_source_scope_or_full_root() {
        let key = json!({"ownerType":"agent","ownerId":"agent_a","topicId":"topic_a"});
        for descriptor in [
            json!({"protectAll":true,"mirrorDeletedTopics":[key]}),
            json!({"mirrorDeletedTopics":[key],"protectedScopes":[{"ownerType":null,"ownerIds":null,"topicIds":null}]}),
            json!({"mirrorDeletedOwners":[{"ownerType":"agent","ownerId":"agent_a"}],"protectedScopes":[{"ownerType":"agent","ownerIds":["agent_a"],"topicIds":["topic_a"]}]}),
        ] {
            assert!(serde_json::from_value::<Descriptor>(descriptor)
                .unwrap()
                .validate()
                .is_err());
        }
    }

    #[tokio::test]
    async fn born_unknown_and_protected_noop_are_denied() {
        let (_temp, a, key, path) = fixture();
        assert!(a.acquire(&key, &path, 0).await.is_err());
        let desc = json!({"protectAll":true,"nativeTopics":[key]});
        assert_eq!(
            a.control(request(&a, "prepare", 1, desc.clone())).await["ok"],
            true
        );
        let mut activate = request(&a, "activate", 1, desc);
        activate.as_object_mut().unwrap().remove("descriptorJson");
        assert_eq!(a.control(activate).await["ok"], true);
        assert!(a.acquire(&key, &path, 1).await.is_err());
        assert_eq!(fs::read(path).unwrap(), b"[]");
    }
    #[tokio::test]
    async fn prepare_waits_for_real_guard_and_fences_old_generation() {
        let (_temp, a, key, path) = fixture();
        active(&a, &key).await;
        let guard = a.acquire(&key, &path, 1).await.unwrap();
        let other = a.clone();
        let c = request(&a, "prepare", 2, json!({"protectAll":true}));
        let mut prepare = tokio::spawn(async move { other.control(c).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut prepare)
                .await
                .is_err()
        );
        // A real atomic History commit still owns the same guard until directory fsync.
        crate::ingest::write_history_guarded(
            &path,
            b"[1]",
            Some(&hex::encode(Sha256::digest(b"[]"))),
            &guard,
        )
        .unwrap();
        drop(guard);
        let ack = prepare.await.unwrap();
        assert_eq!(ack["ok"], true);
        assert_eq!(ack["settled"], true);
        assert!(a.acquire(&key, &path, 1).await.is_err());
        assert_eq!(fs::read(path).unwrap(), b"[1]");
    }
    #[tokio::test]
    async fn final_descriptor_requires_prepared_digest_and_whole_root_fence() {
        let (_temp, a, key, path) = fixture();
        let prepare = request(&a, "prepare", 1, json!({"protectAll":true}));
        let digest = prepare["digest"].clone();
        assert_eq!(a.control(prepare).await["ok"], true);
        let mut final_request = request(&a, "activate", 1, json!({"nativeTopics":[key]}));
        assert_eq!(a.control(final_request.clone()).await["ok"], false);
        final_request["preparedDigest"] = digest;
        assert_eq!(a.control(final_request).await["ok"], true);
        assert!(a.acquire(&key, &path, 1).await.is_ok());
    }
    #[tokio::test]
    async fn identities_and_old_session_are_not_reusable() {
        let (_temp, a, key, _path) = fixture();
        let mut c = active(&a, &key).await;
        c["op"] = json!("inspect");
        assert_eq!(a.control(c.clone()).await["ok"], true);
        c["sessionId"] = json!("other");
        assert_eq!(a.control(c).await["ok"], false);
        let mut c = request(&a, "prepare", 2, json!({}));
        c["rootIdentity"]["inode"] = json!("different");
        assert_eq!(a.control(c).await["ok"], false);
        assert_eq!(a.generation(), 1);
    }
    #[tokio::test]
    async fn native_tombstone_and_hardlink_or_symlink_deny_writes() {
        let (temp, a, key, path) = fixture();
        active(&a, &key).await;
        fs::write(
            temp.path().join("Agents/agent_a/config.json"),
            br#"{"id":"agent_a","topics":[{"id":"topic_a"}],"_historyDeletedTopics":["topic_a"]}"#,
        )
        .unwrap();
        assert!(a.acquire(&key, &path, 1).await.is_err());
        fs::write(
            temp.path().join("Agents/agent_a/config.json"),
            br#"{"id":"agent_a","topics":[{"id":"topic_a"}]}"#,
        )
        .unwrap();
        fs::hard_link(&path, temp.path().join("alias")).unwrap();
        assert!(a.acquire(&key, &path, 1).await.is_err());
        fs::remove_file(temp.path().join("alias")).unwrap();
        #[cfg(unix)]
        {
            fs::rename(&path, temp.path().join("original")).unwrap();
            std::os::unix::fs::symlink(temp.path().join("original"), &path).unwrap();
            assert!(a.acquire(&key, &path, 1).await.is_err());
        }
    }
    #[tokio::test]
    async fn unknown_commit_cannot_sign_settled_or_activate() {
        let (_temp, a, key, path) = fixture();
        active(&a, &key).await;
        let guard = a.acquire(&key, &path, 1).await.unwrap();
        guard.unknown_commit();
        drop(guard);
        let ack = a
            .control(request(&a, "prepare", 2, json!({"protectAll":true})))
            .await;
        assert_eq!(ack["ok"], false);
        assert_eq!(ack["settled"], false);
        assert_eq!(ack["state"], "prepared");
        assert!(a.acquire(&key, &path, 2).await.is_err());
    }
    #[tokio::test]
    async fn entity_tombstones_require_active_identity_and_exclude_partial_owner_scopes() {
        let (_temp, a, key, _path) = fixture();
        assert!(a
            .acquire_entity(
                Some((key.owner_type, &key.owner_id)),
                Some(&key.topic_id),
                0
            )
            .await
            .is_err());
        active(&a, &key).await;
        assert!(a
            .acquire_entity(
                Some((key.owner_type, &key.owner_id)),
                Some(&key.topic_id),
                1
            )
            .await
            .is_ok());
        assert!(a
            .acquire_entity(Some((key.owner_type, &key.owner_id)), None, 1)
            .await
            .is_ok());
        let desc = json!({"nativeTopics":[key],"protectedScopes":[{"ownerType":"agent","ownerIds":["agent_a"],"topicIds":["topic_a"]}]});
        assert_eq!(
            a.control(request(&a, "prepare", 2, desc.clone())).await["ok"],
            true
        );
        let mut c = request(&a, "activate", 2, desc);
        c.as_object_mut().unwrap().remove("descriptorJson");
        assert_eq!(a.control(c).await["ok"], true);
        assert!(a
            .acquire_entity(
                Some((key.owner_type, &key.owner_id)),
                Some(&key.topic_id),
                2
            )
            .await
            .is_err());
        assert!(a
            .acquire_entity(Some((key.owner_type, &key.owner_id)), None, 2)
            .await
            .is_err());
        assert!(a
            .acquire_entity(Some((OwnerType::Agent, "unknown_owner")), None, 2)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn disconnect_keeps_new_admission_closed_while_old_guard_settles() {
        let (_temp, a, key, path) = fixture();
        active(&a, &key).await;
        let guard = a.acquire(&key, &path, 1).await.unwrap();
        let other = a.clone();
        let task = tokio::spawn(async move { other.disconnect().await });
        tokio::task::yield_now().await;
        assert!(!a.connected.load(Ordering::Acquire));
        drop(guard);
        task.await.unwrap();
        assert!(a.acquire(&key, &path, 1).await.is_err());
    }
}
