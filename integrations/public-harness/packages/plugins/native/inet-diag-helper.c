/* Persistent NETLINK_SOCK_DIAG helper for dsh-plugins peer UID checks.
 * Protocol (stdin/stdout, length-prefixed):
 *   request:  uint32_le length | request bytes
 *   response: uint32_le length | response bytes  (length 0 = transport error)
 * Exits on stdin EOF.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/netlink.h>

#ifndef NETLINK_SOCK_DIAG
#define NETLINK_SOCK_DIAG 4
#endif

static int read_full(int fd, void *buf, size_t n) {
  uint8_t *p = buf;
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, p + got, n - got);
    if (r == 0) return 0;
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    got += (size_t)r;
  }
  return 1;
}

static int write_full(int fd, const void *buf, size_t n) {
  const uint8_t *p = buf;
  size_t sent = 0;
  while (sent < n) {
    ssize_t w = write(fd, p + sent, n - sent);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    sent += (size_t)w;
  }
  return 0;
}

static int sockdiag_once(const void *req, size_t req_len, void *out, size_t out_cap, size_t *out_len) {
  int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_SOCK_DIAG);
  if (fd < 0) return -1;
  struct sockaddr_nl addr;
  memset(&addr, 0, sizeof(addr));
  addr.nl_family = AF_NETLINK;
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    close(fd);
    return -1;
  }
  if (send(fd, req, req_len, 0) < 0) {
    close(fd);
    return -1;
  }
  ssize_t r = recv(fd, out, out_cap, 0);
  close(fd);
  if (r < 0) return -1;
  *out_len = (size_t)r;
  return 0;
}

int main(void) {
  uint8_t req[4096];
  uint8_t resp[65536];
  for (;;) {
    uint32_t len = 0;
    int rf = read_full(STDIN_FILENO, &len, 4);
    if (rf == 0) return 0;
    if (rf < 0) return 1;
    if (len == 0 || len > sizeof(req)) return 1;
    if (read_full(STDIN_FILENO, req, len) != 1) return 1;
    size_t out_len = 0;
    uint32_t out_hdr = 0;
    if (sockdiag_once(req, len, resp, sizeof(resp), &out_len) != 0) {
      if (write_full(STDOUT_FILENO, &out_hdr, 4) != 0) return 1;
      continue;
    }
    out_hdr = (uint32_t)out_len;
    if (write_full(STDOUT_FILENO, &out_hdr, 4) != 0) return 1;
    if (out_len > 0 && write_full(STDOUT_FILENO, resp, out_len) != 0) return 1;
  }
}
